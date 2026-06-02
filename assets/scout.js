'use strict';

// ─────────────────────────────────────────────────────────────
// assets/scout.js
// Scout API engine — G7 Capital
//
// This file powers all API calls for Scout, G7's business
// development AI employee for Indian SMEs.
//
// It is completely separate from workspace.js and Alex.
// Do not import or reference anything from workspace.js here.
//
// Functions:
//   callScout(businessContext)           — initial analysis call
//   callScoutCheckin(checkinData)        — weekly check-in call
//   saveScoutResult(rawOutput, weekNum)  — persist result to localStorage
//   getScoutHistory()                    — safe parse of history array
//   getScoutContext()                    — read onboarding context from pending result
//   extractScoutMetrics(text)            — pull 4 key metrics from Scout output
// ─────────────────────────────────────────────────────────────

// Cloudflare Worker base URL — Scout routes live here
const SCOUT_WORKER = 'https://g7-proxy.gsevnservices.workers.dev';


// ─────────────────────────────────────────────────────────────
// FUNCTION 1 — callScout(businessContext)
//
// Sends the initial business onboarding data to Scout for analysis.
// Calls the /scout/analyse endpoint.
//
// businessContext — object built from onboard.html form fields:
//   businessName, city, state, businessType, productService,
//   avgTicket, monthlyRevenue, teamSize, yearsActive, topChallenge,
//   targetCustomer, currentChannels, weeklyContacts, conversionRate,
//   competitors, uniqueAdvantage, languages, seasonalNotes, situation
//
// Returns: Scout's raw text output (string)
// Throws:  Error with user-readable message
// ─────────────────────────────────────────────────────────────
async function callScout(businessContext) {

  // Validate session token is present
  var sessionToken = localStorage.getItem('g7_session_token') || '';

  // Build the system prompt: Scout master prompt + no firm KB needed
  // (Scout has its own full system prompt in SCOUT_SYSTEM_PROMPT)
  var systemPrompt = SCOUT_SYSTEM_PROMPT;

  // Build the user message from the business context object
  var userMessage = buildScoutOnboardMessage(businessContext);

  var response;
  try {
    response = await fetch(SCOUT_WORKER + '/scout/analyse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sessionToken
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [
          {
            role: 'user',
            content: userMessage
          }
        ]
      })
    });
  } catch (networkError) {
    throw new Error('Could not reach Scout. Please check your internet connection and try again.');
  }

  if (!response.ok) {
    var errBody = await response.text();
    throw new Error('Scout API error ' + response.status + ': ' + errBody);
  }

  // Worker returns text/event-stream (streaming SSE) — read via readSSEStream()
  var result = await readSSEStream(response);
  if (!result) {
    throw new Error('Scout returned an empty response. Please try again.');
  }
  return result;
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 1B — callScoutRaw(userMessage)
//
// Sends a raw string message to the /scout/analyse endpoint.
// Used by the Referral Chain Builder in result.html, which
// builds its own prompt rather than using the onboarding form.
//
// userMessage — a pre-formatted string (user message content)
// Returns: Scout's raw text output (string)
// Throws:  Error with user-readable message
// ─────────────────────────────────────────────────────────────
async function callScoutRaw(userMessage) {

  var sessionToken = localStorage.getItem('g7_session_token') || '';
  var systemPrompt = SCOUT_SYSTEM_PROMPT;

  var response;
  try {
    response = await fetch(SCOUT_WORKER + '/scout/analyse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sessionToken
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [
          { role: 'user', content: userMessage }
        ]
      })
    });
  } catch (networkError) {
    throw new Error('Could not reach Scout. Please check your internet connection and try again.');
  }

  if (!response.ok) {
    var errBody = await response.text();
    throw new Error('Scout API error ' + response.status + ': ' + errBody);
  }

  var result = await readSSEStream(response);
  if (!result) {
    throw new Error('Scout returned an empty response. Please try again.');
  }
  return result;
}


// ─────────────────────────────────────────────────────────────
// HELPER — buildScoutOnboardMessage(ctx)
//
// Formats the business context object into a structured prompt
// that matches Scout's Component 7 output format specification.
//
// ctx — the businessContext object from onboard.html
// Returns: formatted string (user message content)
// ─────────────────────────────────────────────────────────────
function buildScoutOnboardMessage(ctx) {
  return [
    'Please analyse this business and produce a complete Scout Analysis',
    'in your standard 4-tab format.',
    '',
    '══════════════════════════════════════════════════',
    'BUSINESS PROFILE',
    '══════════════════════════════════════════════════',
    '',
    'BUSINESS NAME:     ' + (ctx.businessName || 'Not provided'),
    'LOCATION:          ' + (ctx.city || '') + (ctx.state ? ', ' + ctx.state : ''),
    'BUSINESS TYPE:     ' + (ctx.businessType || 'Not provided'),
    'PRODUCT / SERVICE: ' + (ctx.productService || 'Not provided'),
    'AVERAGE TICKET:    ₹' + (ctx.avgTicket || 'Not provided'),
    'MONTHLY REVENUE:   ₹' + (ctx.monthlyRevenue || 'Not provided'),
    'TEAM SIZE:         ' + (ctx.teamSize || 'Not provided') + ' people',
    'YEARS ACTIVE:      ' + (ctx.yearsActive || 'Not provided'),
    'TOP CHALLENGE:     ' + (ctx.topChallenge || 'Not provided'),
    '',
    '── TARGET CUSTOMER ────────────────────────────',
    (ctx.targetCustomer || 'Not provided'),
    '',
    '── CURRENT SALES CHANNELS ─────────────────────',
    (ctx.currentChannels || 'Not provided'),
    '',
    '── WEEKLY SALES ACTIVITY ──────────────────────',
    'Contacts made per week: ' + (ctx.weeklyContacts || 'Not provided'),
    'Current conversion rate: ' + (ctx.conversionRate || 'Not provided'),
    '',
    '── COMPETITION ────────────────────────────────',
    (ctx.competitors || 'Not provided'),
    '',
    '── UNIQUE ADVANTAGE ───────────────────────────',
    (ctx.uniqueAdvantage || 'Not provided'),
    '',
    '── LANGUAGE & COMMUNICATION ───────────────────',
    'Languages used in sales: ' + (ctx.languages || 'Not provided'),
    '',
    '── SEASONAL PATTERNS ──────────────────────────',
    (ctx.seasonalNotes || 'None noted'),
    '',
    '── CURRENT SITUATION ──────────────────────────',
    (ctx.situation || 'Not provided'),
    '',
    '══════════════════════════════════════════════════',
    'ANALYSIS DATE: ' + new Date().toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric'
    }),
    '══════════════════════════════════════════════════',
    '',
    'REQUIRED OUTPUT:',
    'Produce all 4 tabs in sequence:',
    'TAB 1: WHO TO CALL — ICP profiles with contact lists',
    'TAB 2: WHAT TO SAY — Scripts and messaging for each ICP',
    'TAB 3: WHEN TO ACT — Weekly rhythm with day-by-day plan',
    'TAB 4: PIPELINE — Tracking targets and first 30-day milestones'
  ].join('\n');
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 2 — callScoutCheckin(checkinData)
//
// Sends weekly check-in results to Scout for updated guidance.
// Calls the /scout/checkin endpoint.
// Uses a multi-turn conversation: onboarding context → prior output → new data.
//
// checkinData — object with:
//   weekNumber     — current week number (integer)
//   onboardContext — original onboarding user message (string)
//   priorOutput    — Scout's output from previous week (string)
//   contacts       — object: { icp1: n, icp2: n, icp3: n }
//   responses      — object: { icp1: n, icp2: n, icp3: n }
//   customers      — object: { icp1: n, icp2: n, icp3: n }
//   revenue        — total new revenue this week (string, e.g. '45000')
//   wins           — what worked (string)
//   blocks         — what did not work (string)
//   nextFocus      — what the owner wants to focus on next week (string)
//
// Returns: Scout's raw text output (string)
// Throws:  Error with user-readable message
// ─────────────────────────────────────────────────────────────
async function callScoutCheckin(checkinData) {

  var sessionToken = localStorage.getItem('g7_session_token') || '';
  var systemPrompt = SCOUT_SYSTEM_PROMPT;

  // Build multi-turn message array
  // Turn 1: original onboarding context (as user) — so Scout remembers the business
  // Turn 2: Scout's prior output (as assistant) — prior week's recommendations
  // Turn 3: this week's actual results + request for updated plan (as user)
  var messages = [];

  if (checkinData.onboardContext) {
    messages.push({
      role: 'user',
      content: checkinData.onboardContext
    });
  }

  if (checkinData.priorOutput) {
    messages.push({
      role: 'assistant',
      content: checkinData.priorOutput
    });
  }

  // Build the check-in user message
  var checkinMessage = buildCheckinMessage(checkinData);
  messages.push({
    role: 'user',
    content: checkinMessage
  });

  var response;
  try {
    response = await fetch(SCOUT_WORKER + '/scout/checkin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sessionToken
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: messages
      })
    });
  } catch (networkError) {
    throw new Error('Could not reach Scout. Please check your internet connection and try again.');
  }

  if (!response.ok) {
    var errBody = await response.text();
    throw new Error('Scout check-in error ' + response.status + ': ' + errBody);
  }

  // Worker returns text/event-stream (streaming SSE) — read via readSSEStream()
  var result = await readSSEStream(response);
  if (!result) {
    throw new Error('Scout returned an empty response. Please try again.');
  }
  return result;
}


// ─────────────────────────────────────────────────────────────
// HELPER — readSSEStream(response)
//
// Reads an Anthropic SSE streaming response body and assembles
// the full text output. Called by callScout() and callScoutCheckin().
//
// The Anthropic SSE format looks like:
//   data: {"type":"message_start",...}
//   data: {"type":"content_block_start",...}
//   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
//   data: {"type":"message_stop"}
//
// response — the fetch() Response object (must be ok before calling)
// Returns:  full assembled text string
// Throws:   Error if the stream cannot be read
// ─────────────────────────────────────────────────────────────
async function readSSEStream(response) {
  var reader  = response.body.getReader();
  var decoder = new TextDecoder('utf-8');
  var fullText = '';
  var done = false;

  while (!done) {
    var chunk = await reader.read();
    done = chunk.done;

    if (chunk.value) {
      // Decode the raw bytes to a string
      var raw = decoder.decode(chunk.value, { stream: true });

      // Each chunk may contain multiple SSE lines — split and process each
      var lines = raw.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();

        // SSE data lines start with "data: "
        if (!line.startsWith('data: ')) continue;

        var jsonStr = line.slice(6); // strip "data: "

        // "[DONE]" signals end of stream (not used by Anthropic but guard anyway)
        if (jsonStr === '[DONE]') { done = true; break; }

        var event;
        try {
          event = JSON.parse(jsonStr);
        } catch (e) {
          // Malformed line — skip silently
          continue;
        }

        // Append text delta tokens as they arrive
        if (
          event.type === 'content_block_delta' &&
          event.delta &&
          event.delta.type === 'text_delta' &&
          event.delta.text
        ) {
          fullText += event.delta.text;
        }

        // message_stop signals the end of the response
        if (event.type === 'message_stop') {
          done = true;
          break;
        }
      }
    }
  }

  return fullText;
}


// ─────────────────────────────────────────────────────────────
// HELPER — buildCheckinMessage(d)
//
// Formats the weekly check-in data into a structured prompt.
// d — checkinData object from callScoutCheckin
// Returns: formatted string (user message content)
// ─────────────────────────────────────────────────────────────
function buildCheckinMessage(d) {

  // Sum contacts, responses, customers across all 3 ICPs
  var totalContacts  = (parseInt(d.contacts.icp1)  || 0) + (parseInt(d.contacts.icp2)  || 0) + (parseInt(d.contacts.icp3)  || 0);
  var totalResponses = (parseInt(d.responses.icp1) || 0) + (parseInt(d.responses.icp2) || 0) + (parseInt(d.responses.icp3) || 0);
  var totalCustomers = (parseInt(d.customers.icp1) || 0) + (parseInt(d.customers.icp2) || 0) + (parseInt(d.customers.icp3) || 0);

  return [
    'WEEK ' + d.weekNumber + ' CHECK-IN REPORT',
    '══════════════════════════════════════════════════',
    '',
    '── ACTIVITY THIS WEEK ─────────────────────────',
    'Total contacts made: ' + totalContacts,
    '  ICP 1: ' + (d.contacts.icp1 || 0) + ' contacts',
    '  ICP 2: ' + (d.contacts.icp2 || 0) + ' contacts',
    '  ICP 3: ' + (d.contacts.icp3 || 0) + ' contacts',
    '',
    'Total responses: ' + totalResponses,
    '  ICP 1: ' + (d.responses.icp1 || 0) + ' responses',
    '  ICP 2: ' + (d.responses.icp2 || 0) + ' responses',
    '  ICP 3: ' + (d.responses.icp3 || 0) + ' responses',
    '',
    'New customers this week: ' + totalCustomers,
    '  ICP 1: ' + (d.customers.icp1 || 0) + ' new customers',
    '  ICP 2: ' + (d.customers.icp2 || 0) + ' new customers',
    '  ICP 3: ' + (d.customers.icp3 || 0) + ' new customers',
    '',
    'Revenue from new customers: ₹' + (d.revenue || '0'),
    '',
    '── WHAT WORKED ────────────────────────────────',
    (d.wins || 'Nothing noted as working particularly well.'),
    '',
    '── WHAT DID NOT WORK ──────────────────────────',
    (d.blocks || 'No specific blockers noted.'),
    '',
    '── OWNER FOCUS FOR NEXT WEEK ──────────────────',
    (d.nextFocus || 'Continue current approach.'),
    '',
    '══════════════════════════════════════════════════',
    'Based on this week\'s results, please provide:',
    '1. A brief performance assessment (what the numbers mean)',
    '2. An updated 4-tab Scout Analysis for the coming week',
    '   — adjust targets, messages, and timing based on what worked',
    'Use the same TAB 1 / TAB 2 / TAB 3 / TAB 4 format as before.'
  ].join('\n');
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 3 — saveScoutResult(rawOutput, weekNumber)
//
// Persists a Scout result to localStorage.
// Called after every successful callScout() or callScoutCheckin().
//
// rawOutput   — Scout's raw text response (string)
// weekNumber  — the week this result belongs to (integer)
//
// Updates these localStorage keys:
//   scout_pending_result  — the most recent result for result.html to display
//   scout_history         — append to history array (max 12 entries)
//   scout_week_number     — advance the week counter
// ─────────────────────────────────────────────────────────────
function saveScoutResult(rawOutput, weekNumber) {

  var metrics = extractScoutMetrics(rawOutput);

  // Build the result object
  var resultObj = {
    weekNumber:      weekNumber,
    timestamp:       new Date().toISOString(),
    scoutOutput:     rawOutput,
    revenueVelocity: metrics.revenueVelocity,
    acquisitionEff:  metrics.acquisitionEff,
    momentumScore:   metrics.momentumScore,
    momentumNote:    metrics.momentumNote,
    totalContacts:   0,   // populated by checkin.html from user input
    totalResponses:  0,
    totalCustomers:  0
  };

  // Save as pending result (result.html reads this on load)
  localStorage.setItem('scout_pending_result', JSON.stringify(resultObj));

  // Append to history (max 12 entries — oldest dropped first)
  var history = getScoutHistory();
  history.push(resultObj);
  if (history.length > 12) {
    history = history.slice(history.length - 12);
  }
  localStorage.setItem('scout_history', JSON.stringify(history));

  // Advance the week counter
  localStorage.setItem('scout_week_number', String(weekNumber));

  // ── STREAK TRACKING ────────────────────────────────────────
  // Streak = consecutive weeks with a check-in.
  // Increments if last check-in was exactly one week before this one.
  // Resets to 1 if a week was skipped (streak broken).
  updateStreak(weekNumber);

  // ── WEEKLY INSIGHT EXTRACTION ───────────────────────────────
  // If Scout included a SCOUT INSIGHT section in the output,
  // extract and save it for display on result.html.
  extractAndSaveInsight(rawOutput, weekNumber);

  // ── BUSINESS HEALTH SCORE ────────────────────────────────────
  // Calculate and persist the 5-dimension health score
  // so index.html can display it on the dashboard.
  calculateHealthScore();
}


// ─────────────────────────────────────────────────────────────
// HELPER — updateStreak(weekNumber)
//
// Called after every saveScoutResult().
// Compares this week's number against scout_last_checkin_week.
// If consecutive: increments scout_streak.
// If gap: resets scout_streak to 1.
// Updates scout_last_checkin_week to weekNumber.
// ─────────────────────────────────────────────────────────────
function updateStreak(weekNumber) {
  var lastCheckinWeek = parseInt(localStorage.getItem('scout_last_checkin_week') || '0', 10);
  var currentStreak   = parseInt(localStorage.getItem('scout_streak') || '0', 10);

  if (lastCheckinWeek > 0 && lastCheckinWeek === weekNumber - 1) {
    // Consecutive week — increment streak
    currentStreak = currentStreak + 1;
  } else {
    // First check-in, or missed a week — reset to 1
    currentStreak = 1;
  }

  localStorage.setItem('scout_streak',            String(currentStreak));
  localStorage.setItem('scout_last_checkin_week', String(weekNumber));
}


// ─────────────────────────────────────────────────────────────
// HELPER — extractAndSaveInsight(rawOutput, weekNumber)
//
// Extracts the SCOUT INSIGHT section from a check-in output.
// Saves to localStorage for result.html to display.
//
// Saves:
//   scout_weekly_insight — the insight text (string)
//   scout_insight_week   — the week this insight is for (string)
// ─────────────────────────────────────────────────────────────
function extractAndSaveInsight(rawOutput, weekNumber) {
  if (!rawOutput) return;

  var insightMatch = rawOutput.match(
    /SCOUT\s+INSIGHT[^:\n]*:\s*([\s\S]+?)(?=\n={3,}|\n━{3,}|\n[A-Z]{3,}[\s\S]{0,20}:|$)/i
  );

  if (insightMatch && insightMatch[1] && insightMatch[1].trim().length > 20) {
    localStorage.setItem('scout_weekly_insight', insightMatch[1].trim());
    localStorage.setItem('scout_insight_week',   String(weekNumber));
  }
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 4 — getScoutHistory()
//
// Returns the scout_history array from localStorage.
// Safe — always returns an array even if storage is empty or corrupt.
// ─────────────────────────────────────────────────────────────
function getScoutHistory() {
  var raw = localStorage.getItem('scout_history');
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 5 — getScoutContext()
//
// Reads the onboarding context from the pending result in localStorage.
// Used by checkin.html to assemble the multi-turn conversation.
//
// Returns: object { onboardContext, priorOutput, weekNumber }
//   onboardContext — the original user message sent to Scout (string or null)
//   priorOutput    — Scout's last output text (string or null)
//   weekNumber     — current week number (integer, defaults to 1)
// ─────────────────────────────────────────────────────────────
function getScoutContext() {
  var raw = localStorage.getItem('scout_pending_result');
  if (!raw) {
    return { onboardContext: null, priorOutput: null, weekNumber: 1 };
  }

  var obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { onboardContext: null, priorOutput: null, weekNumber: 1 };
  }

  return {
    onboardContext: obj.onboardContext || null,
    priorOutput:    obj.scoutOutput    || null,
    weekNumber:     parseInt(obj.weekNumber) || 1
  };
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 6 — extractScoutMetrics(text)
//
// Parses 4 key metrics from Scout's raw output text.
// Used by result.html and history.html to display headline numbers.
//
// text — Scout's raw output string
//
// Returns: object with 4 fields:
//   revenueVelocity  — string: "₹45,000/month" or null
//   acquisitionEff   — string: "12 contacts" or null
//   momentumScore    — integer: 1–10 or null
//   momentumNote     — string: the momentum label/description or null
// ─────────────────────────────────────────────────────────────
function extractScoutMetrics(text) {
  if (!text) {
    return { revenueVelocity: null, acquisitionEff: null, momentumScore: null, momentumNote: null };
  }

  var revenueVelocity = null;
  var acquisitionEff  = null;
  var momentumScore   = null;
  var momentumNote    = null;

  // Revenue Velocity — try multiple patterns in sequence
  var rvPatterns = [
    /REVENUE\s+VELOCITY[\s\S]{0,200}?(₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?(?:\s*\/\s*month|\s*per\s*month|\s*added\/month))/i,
    /₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?\s*added\/month/i,
    /revenue\s+velocity[:\s]+([₹\d,\.LlKkCcRr\/a-zA-Z\s]+(?:month|week|year))/i,
    /₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?(?:\s*\/\s*month|\s*per\s*month)/i
  ];
  for (var ri = 0; ri < rvPatterns.length; ri++) {
    var rvM = text.match(rvPatterns[ri]);
    if (rvM) {
      revenueVelocity = (rvM[1] || rvM[0]).trim();
      if (!revenueVelocity.startsWith('₹')) revenueVelocity = '₹' + revenueVelocity;
      break;
    }
  }

  // Acquisition Efficiency — try multiple patterns in sequence
  var aePatterns = [
    /ACQUISITION\s+EFFICIENCY[\s\S]{0,300}?(\d+)\s+contacts?\s+(?:needed|per)/i,
    /(\d+)\s+contacts?\s+(?:needed|per)\s+(?:per\s*)?(?:new\s*)?customer/i,
    /acquisition\s+efficiency[:\s]+(\d+)\s+contacts?/i,
    /(\d+)\s+contacts?\s+needed/i
  ];
  for (var ai = 0; ai < aePatterns.length; ai++) {
    var aeM = text.match(aePatterns[ai]);
    if (aeM) { acquisitionEff = aeM[1] + ' contacts'; break; }
  }

  // Momentum Score — try multiple patterns in sequence (Scout outputs score/100)
  var msPatterns = [
    /SCOUT\s+MOMENTUM\s*[:\-]\s*(\d+)/i,
    /MOMENTUM\s*[:\-]\s*(\d+)\/100/i,
    /(\d+)\/100\s*(?:momentum|score)/i,
    /(?:scout\s+)?momentum(?:\s+score)?[:\s]+(\d{1,3})(?:\/(?:10|100))?/i
  ];
  for (var mi = 0; mi < msPatterns.length; mi++) {
    var msM = text.match(msPatterns[mi]);
    if (msM) {
      var score = parseInt(msM[1], 10);
      if (score >= 0 && score <= 100) { momentumScore = score; break; }
    }
  }

  // Momentum Note — the label after the score, e.g. "SCOUT MOMENTUM: 72 — Gaining traction"
  var mnMatch = text.match(/(?:scout\s+)?momentum(?:\s+score)?[:\s]+\d{1,3}(?:\/(?:10|100))?[:\s—\-]+([^\n]+)/i);
  if (mnMatch) {
    momentumNote = mnMatch[1].trim();
  }

  return {
    revenueVelocity: revenueVelocity,
    acquisitionEff:  acquisitionEff,
    momentumScore:   momentumScore,
    momentumNote:    momentumNote
  };
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 7 — calculateHealthScore()
//
// Calculates a 5-dimension Business Health Score (0-100)
// from the most recent check-in data in scout_history.
// Called automatically at end of saveScoutResult().
//
// Saves:
//   scout_health_score     — total score (0-100) as string
//   scout_health_breakdown — object with per-dimension scores
//
// Dimensions (20 pts each):
//   1. Customer Acquisition  — conversion rate vs benchmark
//   2. Revenue Velocity      — revenue vs velocity target
//   3. Customer Retention    — week-over-week customer trend
//   4. Competitive Position  — momentum score band
//   5. Seasonal Preparedness — festival/seasonal activity
// ─────────────────────────────────────────────────────────────
function calculateHealthScore() {
  var history = getScoutHistory();
  if (!history || history.length === 0) return;

  var lastEntry = history[history.length - 1];
  var prevEntry = history.length > 1 ? history[history.length - 2] : null;

  var breakdown = {};
  var total = 0;

  // ── DIMENSION 1: Customer Acquisition (20 pts) ──────────────
  var totalContacts = (parseInt(lastEntry.icp1_sent,    10) || 0) +
                      (parseInt(lastEntry.icp2_sent,    10) || 0) +
                      (parseInt(lastEntry.icp3_sent,    10) || 0);
  var totalConv     = (parseInt(lastEntry.icp1_conv,    10) || 0) +
                      (parseInt(lastEntry.icp2_conv,    10) || 0) +
                      (parseInt(lastEntry.icp3_conv,    10) || 0);
  var convRate      = totalContacts > 0 ? totalConv / totalContacts : 0;
  var benchmark     = 0.15; // Tier 3 default; Metro is 0.20

  var contactsTarget = 0;
  try {
    var tRaw = localStorage.getItem('scout_last_targets');
    if (tRaw) contactsTarget = parseInt(JSON.parse(tRaw).contacts || 0, 10) || 0;
  } catch (e) {}

  var acqScore;
  if (totalContacts === 0) {
    acqScore = 0;
  } else if (convRate > benchmark) {
    acqScore = 20;
  } else if (Math.abs(convRate - benchmark) < 0.02) {
    acqScore = 15;
  } else if (contactsTarget > 0 && totalContacts >= contactsTarget) {
    acqScore = 10;
  } else {
    acqScore = 5;
  }
  breakdown.acquisition = { score: acqScore, label: 'Customer Acquisition' };
  total += acqScore;

  // ── DIMENSION 2: Revenue Velocity (20 pts) ──────────────────
  var revenueAdded   = parseFloat(lastEntry.revenueAdded) || 0;
  var velocityTarget = 0;
  if (lastEntry.scoutOutput) {
    var vtMatch = lastEntry.scoutOutput.match(/REVENUE\s+VELOCITY\s+TARGET\s*:\s*₹?([\d,]+)/i);
    if (vtMatch) velocityTarget = parseFloat(vtMatch[1].replace(/,/g, '')) || 0;
  }

  var revScore;
  if (revenueAdded === 0) {
    revScore = 0;
  } else if (velocityTarget <= 0 || revenueAdded >= velocityTarget) {
    revScore = 20;
  } else if (revenueAdded >= velocityTarget * 0.75) {
    revScore = 15;
  } else if (revenueAdded >= velocityTarget * 0.50) {
    revScore = 10;
  } else {
    revScore = 5;
  }
  breakdown.revenue = { score: revScore, label: 'Revenue Velocity' };
  total += revScore;

  // ── DIMENSION 3: Customer Retention (20 pts) ─────────────────
  var lastCust = parseInt(lastEntry.totalCustomers, 10) || 0;
  var prevCust = prevEntry !== null ? (parseInt(prevEntry.totalCustomers, 10) || 0) : -1;

  var retScore;
  if (prevCust === -1) {
    retScore = 15; // first check-in — no prior data, neutral
  } else if (lastCust > prevCust) {
    retScore = 20;
  } else if (lastCust === prevCust) {
    retScore = 15;
  } else if (prevCust > 0 && lastCust >= prevCust * 0.8) {
    retScore = 10;
  } else {
    retScore = 0;
  }
  breakdown.retention = { score: retScore, label: 'Customer Retention' };
  total += retScore;

  // ── DIMENSION 4: Competitive Position (20 pts) ───────────────
  var momentum  = parseInt(lastEntry.momentum, 10) || 0;
  var compScore;
  if (momentum > 60) {
    compScore = 20;
  } else if (momentum >= 40) {
    compScore = 15;
  } else if (momentum >= 20) {
    compScore = 10;
  } else {
    compScore = 5;
  }
  breakdown.competitive = { score: compScore, label: 'Competitive Position' };
  total += compScore;

  // ── DIMENSION 5: Seasonal Preparedness (20 pts) ──────────────
  var seasonalScore = 10; // default: standard weekly activity
  if (totalContacts === 0 && revenueAdded === 0) {
    // No activity at all this week
    seasonalScore = 0;
  } else if (lastEntry.scoutOutput) {
    var seasonalRe = /festival|diwali|holi|eid|navratri|puja|christmas|campaign|seasonal|offer|mela|rakhi|onam|lohri|baisakhi/i;
    if (seasonalRe.test(lastEntry.scoutOutput)) {
      seasonalScore = 20;
    }
  }
  breakdown.seasonal = { score: seasonalScore, label: 'Seasonal Preparedness' };
  total += seasonalScore;

  localStorage.setItem('scout_health_score',     String(Math.min(total, 100)));
  localStorage.setItem('scout_health_breakdown', JSON.stringify(breakdown));
}


// ─────────────────────────────────────────────────────────────
// MODULE EXPORT (Node.js validation only)
// Not used in browser — Scout pages load this via <script> tag
// ─────────────────────────────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = { callScout, callScoutRaw, callScoutCheckin, saveScoutResult, getScoutHistory, getScoutContext, extractScoutMetrics, calculateHealthScore };
}
