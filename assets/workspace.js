// ═══════════════════════════════════════════════════════════════
// G7 WORKSPACE — SHARED JAVASCRIPT ENGINE
// File: assets/workspace.js
//
// This file is the core engine for the entire G7 Workspace.
// It must be loaded by every workspace HTML page via:
//   <script src="../assets/workspace.js"></script>
//
// Load order in every workspace page:
//   1. alex-master-v1.js   (defines ALEX_MASTER_PROMPT constant)
//   2. workspace.js        (this file — uses ALEX_MASTER_PROMPT)
//
// localStorage keys used across the workspace:
//   g7_api_key              — Anthropic API key
//   g7_firm_knowledge_base  — Full firm KB text, injected into every Alex call
//   g7_firm_config          — JSON object with firm configuration details
//   g7_deal_history         — JSON array of all screened deals
//   g7_calibration_log      — JSON array of partner corrections to Alex
//   g7_onboarded            — 'true' once firm has completed onboarding
//   g7_pending_result       — Temp storage for last Alex output, read by result.html
// ═══════════════════════════════════════════════════════════════

'use strict';

// ─────────────────────────────────────────────────────────────
// 1. callAlex(dealSubmission)
//
// The core API call. Assembles the full system prompt and user
// message, calls the Anthropic API, and returns Alex's response.
//
// dealSubmission is an object with:
//   companyName  (string, required)
//   source       (string, required) — how the deal came in
//   partnerFocus (string, optional) — specific instructions from partner
//   content      (string, required) — the full deal text or extracted PDF text
//
// Returns: Alex's full text response (string)
// Throws:  Error with a user-readable message if something goes wrong
// ─────────────────────────────────────────────────────────────
async function callAlex(dealSubmission) {

  // 1a. API key is stored in localStorage during onboarding but is NOT sent
  //     from the browser. The Cloudflare Worker adds it server-side using
  //     an environment variable. We still check it exists so onboarding
  //     is enforced — the key validates that the firm completed setup.
  var apiKey = localStorage.getItem('g7_api_key');
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('No API key found. Please complete firm setup before screening a deal.');
  }

  // 1b. Get the firm knowledge base from localStorage
  var firmKB = localStorage.getItem('g7_firm_knowledge_base');
  if (!firmKB || firmKB.trim() === '') {
    throw new Error('No firm configuration found. Please complete onboarding before screening a deal.');
  }

  // 1c. Assemble the full system prompt:
  //     Alex's master prompt + the firm's knowledge base
  //     The firm KB is appended so it overrides generic defaults
  var systemPrompt = ALEX_MASTER_PROMPT + '\n\n' + firmKB;

  // 1d. Build the structured user message
  //     This is the deal submission in the format Alex expects
  var userMessage = [
    'Please screen the following deal and produce a complete',
    'G7 Workspace Deal Screening Note in your standard format.',
    '',
    'COMPANY:        ' + dealSubmission.companyName,
    'SOURCE:         ' + dealSubmission.source,
    'SPECIFIC FOCUS: ' + (dealSubmission.partnerFocus || 'Standard full screening — no specific focus requested'),
    '',
    'DEAL MATERIALS:',
    '───────────────────────────────────────────────',
    dealSubmission.content,
    '───────────────────────────────────────────────'
  ].join('\n');

  // 1e. Make the API call via the Cloudflare Worker proxy.
  //     The worker adds the API key server-side — we do not send it from the browser.
  //     Replace the placeholder URL below with your deployed worker URL after deploying.
  var PROXY_URL = 'https://g7-proxy.gsevnservices.workers.dev/api/message';

  var response;
  try {
    response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userMessage }
        ]
      })
    });
  } catch (networkError) {
    // Network-level failure (no internet, worker unreachable, etc.)
    throw new Error('Could not reach the G7 proxy. Please check your internet connection and try again.');
  }

  // 1f. Parse the response JSON
  var data;
  try {
    data = await response.json();
  } catch (parseError) {
    throw new Error('Received an unexpected response from the API. Please try again.');
  }

  // 1g. Handle API-level errors (wrong key, quota exceeded, etc.)
  if (data.error) {
    var msg = data.error.message || 'Unknown API error';
    // Surface common errors in plain English
    if (data.error.type === 'authentication_error') {
      throw new Error('Invalid API key. Please check your Anthropic API key in Settings.');
    }
    if (data.error.type === 'rate_limit_error') {
      throw new Error('Rate limit reached. Please wait a moment and try again.');
    }
    if (data.error.type === 'overloaded_error') {
      throw new Error('Anthropic\'s servers are busy. Please try again in a moment.');
    }
    throw new Error('API error: ' + msg);
  }

  // 1h. Extract the text response
  if (!data.content || !data.content[0] || !data.content[0].text) {
    throw new Error('Alex returned an empty response. Please try again.');
  }

  return data.content[0].text;
}


// ─────────────────────────────────────────────────────────────
// 2. saveDeal(companyName, source, dealContent, alexOutput)
//
// Saves a completed screening to the deal history in localStorage.
// Called immediately after a successful callAlex() response.
//
// Returns: the deal id (timestamp string) for use in redirects
// ─────────────────────────────────────────────────────────────
function saveDeal(companyName, source, dealContent, alexOutput) {

  // Build the deal object
  var dealId = Date.now().toString();
  var deal = {
    id:                dealId,
    companyName:       companyName,
    source:            source,
    dealContent:       dealContent,       // original submission text
    alexOutput:        alexOutput,         // Alex's full raw text response
    dateScreened:      new Date().toISOString(),
    partnerDecision:   null,              // null until partner acts (agreed / overridden)
    calibrationAdded:  false             // true once partner disagrees and adds a correction
  };

  // Load existing history, append new deal, save back
  var history = loadAllDeals();
  history.unshift(deal); // newest deal goes to the front of the array
  localStorage.setItem('g7_deal_history', JSON.stringify(history));

  return dealId;
}


// ─────────────────────────────────────────────────────────────
// 3. loadDealById(id)
//
// Retrieves a single deal from the history by its id.
// Used by result.html to load the deal being viewed.
//
// Returns: the deal object, or null if not found
// ─────────────────────────────────────────────────────────────
function loadDealById(id) {
  var history = loadAllDeals();
  for (var i = 0; i < history.length; i++) {
    if (history[i].id === id) {
      return history[i];
    }
  }
  return null;
}


// ─────────────────────────────────────────────────────────────
// 4. loadAllDeals()
//
// Returns the full deal history array from localStorage.
// Always returns an array — empty array if nothing exists yet.
// ─────────────────────────────────────────────────────────────
function loadAllDeals() {
  var raw = localStorage.getItem('g7_deal_history');
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}


// ─────────────────────────────────────────────────────────────
// 5. updateDealDecision(id, decision)
//
// Records whether the partner agreed with or overrode Alex's verdict.
// Called from result.html when the partner clicks Agree or Disagree.
//
// decision: 'agreed' or 'overridden'
// ─────────────────────────────────────────────────────────────
function updateDealDecision(id, decision) {
  var history = loadAllDeals();
  for (var i = 0; i < history.length; i++) {
    if (history[i].id === id) {
      history[i].partnerDecision = decision;
      break;
    }
  }
  localStorage.setItem('g7_deal_history', JSON.stringify(history));
}


// ─────────────────────────────────────────────────────────────
// 6. addCalibration(dealId, alexAssessment, partnerDecision,
//                  reasonForDisagreement, learningRule)
//
// This is Alex's memory system. When a partner disagrees with Alex,
// their correction is:
//   a) Saved to the calibration log (g7_calibration_log)
//   b) Appended to the firm knowledge base (g7_firm_knowledge_base)
//      so that the NEXT API call automatically includes this learning
//
// This is how Alex gets smarter — correction by correction.
//
// Returns: the calibration entry object
// ─────────────────────────────────────────────────────────────
function addCalibration(dealId, alexAssessment, partnerDecision, reasonForDisagreement, learningRule) {

  // Load existing calibration log
  var log = loadCalibrationLog();

  // Build calibration number (sequential, starting at 1)
  var calibNumber = log.length + 1;
  var now = new Date();
  var dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Build the calibration entry object
  var entry = {
    id:                   Date.now().toString(),
    dealId:               dealId,
    calibrationNumber:    calibNumber,
    date:                 now.toISOString(),
    alexAssessment:       alexAssessment,
    partnerDecision:      partnerDecision,
    reasonForDisagreement: reasonForDisagreement,
    learningRule:         learningRule
  };

  // Append to calibration log and save
  log.push(entry);
  localStorage.setItem('g7_calibration_log', JSON.stringify(log));

  // Get the deal's company name for the KB entry
  var deal = loadDealById(dealId);
  var companyName = deal ? deal.companyName : 'Unknown Company';

  // Build the text block to append to the firm knowledge base
  // This is the correction Alex will read at the start of every future session
  var calibrationText = [
    '',
    '───────────────────────────────────────────────',
    'FIRM-SPECIFIC CALIBRATION #' + calibNumber,
    'DATE:               ' + dateStr,
    'DEAL:               ' + companyName,
    'ALEX\'S ASSESSMENT:  ' + alexAssessment,
    'PARTNER DECISION:   ' + partnerDecision,
    'REASON:             ' + reasonForDisagreement,
    'LEARNING:           ' + learningRule,
    '───────────────────────────────────────────────'
  ].join('\n');

  // Append this correction to the live firm knowledge base
  // The next API call will include it automatically
  var currentKB = localStorage.getItem('g7_firm_knowledge_base') || '';

  // Find the FIRM-SPECIFIC CALIBRATION NOTES section and append there
  // If the section exists, insert after it; otherwise append at end
  var calibrationHeader = 'FIRM-SPECIFIC CALIBRATION NOTES:';
  if (currentKB.indexOf(calibrationHeader) !== -1) {
    // Insert directly after the calibration section header line
    var insertPoint = currentKB.indexOf(calibrationHeader) + calibrationHeader.length;
    currentKB = currentKB.slice(0, insertPoint) + calibrationText + currentKB.slice(insertPoint);
  } else {
    // Fallback: just append to the end of the KB
    currentKB = currentKB + calibrationText;
  }

  localStorage.setItem('g7_firm_knowledge_base', currentKB);

  // Mark the deal as having a calibration added
  updateDealDecision(dealId, 'overridden');
  var history = loadAllDeals();
  for (var i = 0; i < history.length; i++) {
    if (history[i].id === dealId) {
      history[i].calibrationAdded = true;
      break;
    }
  }
  localStorage.setItem('g7_deal_history', JSON.stringify(history));

  return entry;
}


// ─────────────────────────────────────────────────────────────
// Helper: loadCalibrationLog()
// Returns the full calibration log array from localStorage.
// ─────────────────────────────────────────────────────────────
function loadCalibrationLog() {
  var raw = localStorage.getItem('g7_calibration_log');
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}


// ─────────────────────────────────────────────────────────────
// 7. loadFirmConfig()
//
// Returns the firm configuration object from localStorage.
// Used by the dashboard and other pages to display firm info.
//
// Returns: parsed JSON object, or null if not onboarded
// ─────────────────────────────────────────────────────────────
function loadFirmConfig() {
  var raw = localStorage.getItem('g7_firm_config');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
// 8. isOnboarded()
//
// Returns true if the firm has completed onboarding.
// Every workspace page must check this on load and redirect
// to onboard.html if it returns false.
// ─────────────────────────────────────────────────────────────
function isOnboarded() {
  return localStorage.getItem('g7_onboarded') === 'true';
}


// ─────────────────────────────────────────────────────────────
// 9. exportNoteAsPDF(dealId)
//
// Opens Alex's screening note in a new browser window
// formatted for printing, then triggers the print dialog.
//
// The print window uses a clean professional layout:
// white background, black text, no navigation, no UI chrome.
// This produces a PDF when the user saves from the print dialog.
// ─────────────────────────────────────────────────────────────
function exportNoteAsPDF(dealId) {
  var deal = loadDealById(dealId);
  if (!deal) {
    alert('Deal not found. Cannot export.');
    return;
  }

  // Format the date for the header
  var screenedDate = new Date(deal.dateScreened);
  var formattedDate = screenedDate.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  // Convert Alex's plain text output to basic HTML for printing
  // Preserve line breaks and section formatting
  var noteHtml = deal.alexOutput
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Bold text between ── or === markers (section headers)
    .replace(/^(━+.+━*)$/gm, '<div class="section-rule">$1</div>')
    .replace(/^(═+.+═*)$/gm, '<div class="section-rule">$1</div>')
    // Line breaks to <br>
    .replace(/\n/g, '<br>');

  // Build the complete printable HTML document
  var printHTML = '<!DOCTYPE html><html><head>' +
    '<meta charset="UTF-8">' +
    '<title>G7 Workspace — ' + deal.companyName + ' — Screening Note</title>' +
    '<style>' +
    // Reset
    '*{margin:0;padding:0;box-sizing:border-box}' +
    // Page setup
    '@page{margin:20mm 18mm;size:A4}' +
    'body{font-family:"Georgia",serif;font-size:11pt;color:#1a1a1a;' +
      'background:#fff;line-height:1.7;max-width:720px;margin:0 auto;padding:20px}' +
    // Print header
    '.print-header{border-bottom:2px solid #1a1a1a;padding-bottom:16px;margin-bottom:28px}' +
    '.print-firm{font-family:"Arial",sans-serif;font-size:9pt;letter-spacing:.15em;' +
      'text-transform:uppercase;color:#666;margin-bottom:6px}' +
    '.print-title{font-size:22pt;font-weight:400;line-height:1.15;margin-bottom:8px}' +
    '.print-meta{font-family:"Arial",sans-serif;font-size:9pt;color:#888;' +
      'display:flex;gap:32px;flex-wrap:wrap}' +
    // Note body
    '.note-body{font-size:10.5pt;line-height:1.75;white-space:pre-wrap;' +
      'font-family:"Courier New",monospace}' +
    '.section-rule{color:#444;font-weight:600}' +
    // Print footer
    '.print-footer{margin-top:40px;padding-top:16px;border-top:1px solid #ccc;' +
      'font-family:"Arial",sans-serif;font-size:8pt;color:#aaa;' +
      'display:flex;justify-content:space-between}' +
    // Hide on screen, show on print
    '@media screen{body{padding:40px;max-width:800px}}' +
    '</style>' +
    '</head><body>' +
    // Header block
    '<div class="print-header">' +
      '<div class="print-firm">G7 Workspace — Deal Screening Note</div>' +
      '<div class="print-title">' + deal.companyName + '</div>' +
      '<div class="print-meta">' +
        '<span>Screened: ' + formattedDate + '</span>' +
        '<span>Source: ' + deal.source + '</span>' +
        (deal.partnerDecision ? '<span>Partner: ' + deal.partnerDecision + '</span>' : '') +
      '</div>' +
    '</div>' +
    // Note body
    '<div class="note-body">' + noteHtml + '</div>' +
    // Footer
    '<div class="print-footer">' +
      '<span>G7 Capital — Confidential</span>' +
      '<span>Generated by Alex — G7 Workspace</span>' +
    '</div>' +
    // Auto-trigger print dialog once the window is loaded
    '<script>window.onload = function(){ window.print(); }<\/script>' +
    '</body></html>';

  // Open in new window and write the document
  var printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) {
    alert('Could not open print window. Please allow pop-ups for this site.');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(printHTML);
  printWindow.document.close();
}


// ─────────────────────────────────────────────────────────────
// 10. clearWorkspace()
//
// Clears all G7 Workspace data from localStorage.
// Used for reset or logout functionality.
// Requires explicit confirmation before executing.
// ─────────────────────────────────────────────────────────────
function clearWorkspace() {
  var confirmed = confirm(
    'This will clear all workspace data including your firm configuration, ' +
    'deal history, and calibration log.\n\n' +
    'This cannot be undone.\n\n' +
    'Are you sure?'
  );
  if (!confirmed) return false;

  // Remove all G7-specific keys from localStorage
  var keysToRemove = [
    'g7_api_key',
    'g7_firm_knowledge_base',
    'g7_firm_config',
    'g7_deal_history',
    'g7_calibration_log',
    'g7_onboarded',
    'g7_pending_result'
  ];

  keysToRemove.forEach(function(key) {
    localStorage.removeItem(key);
  });

  return true;
}


// ─────────────────────────────────────────────────────────────
// UTILITY: parseAlexScore(alexOutput)
//
// Extracts the G7 Score and verdict from Alex's raw text output.
// Used by result.html and history.html to display scores in lists.
//
// Returns an object:
//   { score: number|null, verdict: string|null, status: string|null }
//
// Alex's output contains a G7 SCORE section — this function
// finds the total score and interpretation.
// ─────────────────────────────────────────────────────────────
function parseAlexScore(alexOutput) {
  if (!alexOutput) return { score: null, verdict: null, status: null };

  var result = { score: null, verdict: null, status: null };

  // Look for score patterns like "G7 SCORE: 72/100" or "TOTAL: 72"
  // or "72 / 100" in various formats Alex might use
  var scorePatterns = [
    /G7\s*SCORE[:\s]+(\d{1,3})\s*\/\s*100/i,
    /TOTAL\s*SCORE[:\s]+(\d{1,3})/i,
    /SCORE[:\s]+(\d{1,3})\s*\/\s*100/i,
    /(\d{1,3})\s*\/\s*100/
  ];
  for (var i = 0; i < scorePatterns.length; i++) {
    var match = alexOutput.match(scorePatterns[i]);
    if (match) {
      var num = parseInt(match[1], 10);
      if (num >= 0 && num <= 100) {
        result.score = num;
        break;
      }
    }
  }

  // Derive verdict and status badge from score
  if (result.score !== null) {
    if (result.score >= 85) {
      result.verdict = 'Exceptional';
      result.status  = 'PRIORITY REVIEW';
    } else if (result.score >= 70) {
      result.verdict = 'Strong';
      result.status  = 'RECOMMEND MEETING';
    } else if (result.score >= 55) {
      result.verdict = 'Promising';
      result.status  = 'WARRANTS REVIEW';
    } else if (result.score >= 40) {
      result.verdict = 'Borderline';
      result.status  = 'CONDITIONAL PASS';
    } else if (result.score >= 25) {
      result.verdict = 'Weak';
      result.status  = 'PASS';
    } else {
      result.verdict = 'Clear Pass';
      result.status  = 'PASS';
    }
  }

  // Also look for explicit RECOMMEND / PASS / PROCEED text
  if (alexOutput.match(/\bRECOMMEND\s*PROCEED\b/i)) result.status = 'PROCEED';
  if (alexOutput.match(/\bRECOMMEND\s*PASS\b/i))    result.status = 'PASS';
  if (alexOutput.match(/\bIMMEDIATE\s*PASS\b/i))     result.status = 'PASS';

  return result;
}


// ─────────────────────────────────────────────────────────────
// UTILITY: formatDate(isoString)
//
// Converts an ISO date string to a readable format.
// e.g. "2026-03-29T14:22:00.000Z" → "29 March 2026"
// ─────────────────────────────────────────────────────────────
function formatDate(isoString) {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch (e) {
    return isoString;
  }
}


// ─────────────────────────────────────────────────────────────
// GUARD: requireOnboarding()
//
// Call this at the top of every workspace page's script.
// If the firm is not onboarded, redirects to onboard.html
// and stops execution.
//
// Usage at top of any workspace page script:
//   requireOnboarding();
// ─────────────────────────────────────────────────────────────
function requireOnboarding() {
  if (!isOnboarded()) {
    window.location.href = 'onboard.html';
    // Throw to stop any further JS execution on this page
    throw new Error('Redirecting to onboarding.');
  }
}
