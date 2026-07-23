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


// ============================================================
// SERVER STATE SYNC — mirrors Scout's localStorage state to KV
// so a customer's data survives across devices / browser clears.
// One JSON blob saved under firms:{CODE}:scout_state via /data/save.
// ============================================================

// The complete set of Scout state keys to sync (session keys excluded —
// those are set by login, not part of Scout's per-account data).
var SCOUT_STATE_KEYS = [
  'scout_pending_result',
  'scout_history',
  'scout_week_number',
  'scout_streak',
  'scout_last_checkin_week',
  'scout_health_score',
  'scout_health_breakdown',
  'scout_weekly_insight',
  'scout_insight_week',
  'scout_last_targets',
  'scout_icp_names',
  'scout_first_customer_celebrated',
  'scout_week_checklist',
  'scout_referral_chain'
];

// Bundle all Scout state keys from localStorage into one object and
// POST to the server. Fire-and-forget: logs on failure, never throws.
async function saveScoutStateToServer() {
  try {
    var token = localStorage.getItem('g7_session_token') || '';
    if (!token) return;
    var blob = {};
    for (var i = 0; i < SCOUT_STATE_KEYS.length; i++) {
      var k = SCOUT_STATE_KEYS[i];
      var v = localStorage.getItem(k);
      if (v !== null) blob[k] = v;
    }
    await fetch(SCOUT_WORKER + '/data/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ type: 'scout_state', data: blob })
    });
  } catch (e) {
    console.warn('Scout state save failed (non-blocking):', e);
  }
}

// Load Scout state blob from the server and write each key into
// localStorage, seeding this device. Returns true if data was loaded,
// false if none / on error. Never throws.
async function loadScoutStateFromServer() {
  // Always clear this browser's Scout state first, so an account can never
  // see another account's residual localStorage data. Server is source of truth.
  for (var c = 0; c < SCOUT_STATE_KEYS.length; c++) {
    localStorage.removeItem(SCOUT_STATE_KEYS[c]);
  }
  try {
    var token = localStorage.getItem('g7_session_token') || '';
    if (!token) return false;
    var res = await fetch(SCOUT_WORKER + '/data/load?type=scout_state', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return false;
    var json = await res.json();
    var blob = json && json.data ? json.data : null;
    if (!blob) return false;
    for (var key in blob) {
      if (blob.hasOwnProperty(key) && blob[key] !== null && blob[key] !== undefined) {
        localStorage.setItem(key, blob[key]);
      }
    }
    return true;
  } catch (e) {
    console.warn('Scout state load failed (non-blocking):', e);
    return false;
  }
}


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
        model: 'claude-sonnet-4-6',
        max_tokens: 12000,
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
    if (response.status === 403) {
      var parsed = null;
      try { parsed = JSON.parse(errBody); } catch (e) {}
      if (parsed && parsed.error === 'limit_reached') {
        var limitErr = new Error('limit_reached');
        limitErr.code = 'limit_reached';
        limitErr.limit = parsed.limit || 'analysis';
        throw limitErr;
      }
    }
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
        model: 'claude-sonnet-4-6',
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
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
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
    if (response.status === 403) {
      var parsed = null;
      try { parsed = JSON.parse(errBody); } catch (e) {}
      if (parsed && parsed.error === 'limit_reached') {
        var limitErr = new Error('limit_reached');
        limitErr.code = 'limit_reached';
        limitErr.limit = parsed.limit || 'checkin';
        throw limitErr;
      }
    }
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
  var buffer = '';
  var done = false;

  while (!done) {
    var chunk = await reader.read();
    done = chunk.done;

    if (chunk.value) {
      // Append decoded bytes to the buffer (do NOT split per-chunk)
      buffer += decoder.decode(chunk.value, { stream: true });

      // Process only COMPLETE lines; keep the trailing partial line in the buffer
      var newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        var line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith('data: ')) continue;

        var jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') { done = true; break; }

        var event;
        try {
          event = JSON.parse(jsonStr);
        } catch (e) {
          // A genuinely malformed complete line — skip
          continue;
        }

        if (
          event.type === 'content_block_delta' &&
          event.delta &&
          event.delta.type === 'text_delta' &&
          event.delta.text
        ) {
          fullText += event.delta.text;
        }

        if (event.type === 'message_stop') {
          done = true;
          break;
        }
      }
    }
  }

  // Flush any final complete data line left in the buffer (no trailing newline)
  var tail = buffer.trim();
  if (tail.startsWith('data: ')) {
    var tailJson = tail.slice(6);
    try {
      var tailEvent = JSON.parse(tailJson);
      if (
        tailEvent.type === 'content_block_delta' &&
        tailEvent.delta &&
        tailEvent.delta.type === 'text_delta' &&
        tailEvent.delta.text
      ) {
        fullText += tailEvent.delta.text;
      }
    } catch (e) { /* ignore incomplete tail */ }
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

  // Override metrics with JSON headline values if Scout output is valid JSON
  // (new architecture: TYPE 1 onboarding outputs pure JSON)
  try {
    var _cleaned = rawOutput
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '').trim();
    var _parsed = JSON.parse(_cleaned);
    if (_parsed && _parsed.headline) {
      var _hl = _parsed.headline;
      if (_hl.revenueVelocity)      metrics.revenueVelocity = _hl.revenueVelocity;
      if (_hl.acquisitionEfficiency) metrics.acquisitionEff  = _hl.acquisitionEfficiency;
      if (typeof _hl.momentumScore === 'number') metrics.momentumScore = _hl.momentumScore;
      if (_hl.momentumNote)          metrics.momentumNote    = _hl.momentumNote;
    }
  } catch(e) { /* not JSON — keep regex-extracted metrics */ }

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

  // Advance the week counter and clear the scorecard checklist for the new week
  localStorage.setItem('scout_week_number', String(weekNumber));
  localStorage.removeItem('scout_week_checklist');

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

  // ── USAGE TRACKING ───────────────────────────────────────────
  // Fire-and-forget: increment Scout usage counters in KV.
  // Does not block — failure is silently swallowed.
  try {
    var _firmCode = localStorage.getItem('g7_session_firm') || 'unknown';
    var _pending  = {};
    try {
      _pending = JSON.parse(
        localStorage.getItem('scout_pending_result') || '{}'
      );
    } catch(e) {}
    var _bizData = _pending.businessData || {};

    fetch(SCOUT_WORKER + '/scout/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firmCode:     _firmCode,
        businessType: _bizData.whatYouSell
          ? String(_bizData.whatYouSell).slice(0, 50)
          : (_bizData.businessType
              ? String(_bizData.businessType).slice(0, 50)
              : ''),
        city: _bizData.location
          ? String(_bizData.location).slice(0, 30)
          : (_bizData.city
              ? String(_bizData.city).slice(0, 30)
              : '')
      })
    }).catch(function() {}); // intentionally no await — fire and forget
  } catch(e) {}
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
    /* Defensive: strip any fenced code block (e.g. an appended JSON patch)
       so raw JSON can never render in the Scout Insight card */
    var cleanInsight = insightMatch[1]
      .replace(/```[\s\S]*?```/g, '')   /* closed fences */
      .replace(/```[\s\S]*$/, '')       /* unclosed fence to end of string */
      .trim();
    if (cleanInsight.length > 20) {
      localStorage.setItem('scout_weekly_insight', cleanInsight);
      localStorage.setItem('scout_insight_week',   String(weekNumber));
    }
  }
}


/* ---------- Check-in patch: parse + apply (Task 3) ---------- */

/* Extracts a fenced JSON patch block from TYPE-2 output.
   Returns the parsed object, or null if absent/malformed.
   Never throws — a non-compliant generation must degrade silently. */
function parseCheckinPatch(rawOutput) {
  if (!rawOutput) return null;
  try {
    var m = rawOutput.match(/```json\s*([\s\S]*?)```/i);
    if (!m || !m[1]) return null;
    var patch = JSON.parse(m[1].trim());
    if (!patch || typeof patch !== 'object') return null;
    if (!Array.isArray(patch.changed)) return null;
    return patch;
  } catch (e) {
    console.warn('Check-in patch parse failed:', e);
    return null;
  }
}

/* Applies a patch to the stored TYPE-1 plan object.
   Mutates and returns a NEW object. Returns the original unchanged
   if the patch is null or nothing applies. Never throws. */
function applyCheckinPatch(plan, patch, weekNumber) {
  if (!plan || !patch || !Array.isArray(patch.changed)) return plan;
  var out;
  try { out = JSON.parse(JSON.stringify(plan)); } catch (e) { return plan; }

  try {
    var tab1 = out.tab1 || {};
    var tab2 = out.tab2 || {};
    var icps = Array.isArray(tab1.icps) ? tab1.icps : [];
    var msgs = Array.isArray(tab2.messages) ? tab2.messages : [];

    /* Guard: never retire unless this patch also adds at least one message */
    var hasAdd = patch.changed.some(function(c){ return c.type === 'message_add'; });

    patch.changed.forEach(function(c) {
      if (!c || !c.type) return;

      if (c.type === 'message_retire' && hasAdd) {
        var i = findIdx(msgs, c.target_icp, c.target_index);
        if (i > -1 && msgs.length > 1) {
          msgs[i].status        = 'retired';
          msgs[i].retiredWeek   = weekNumber;
          msgs[i].retiredReason = c.reason || '';
        }
      }

      if (c.type === 'message_add' && c.content) {
        msgs.push({
          icp: c.for_icp || '',
          type: 'primary',
          channel: c.channel || 'WhatsApp',
          language: c.language || '',
          versionA: c.content,
          followupDay3: c.followupDay3 || '',
          followupDay7: c.followupDay7 || '',
          status: 'active',
          addedWeek: weekNumber,
          addedReason: c.reason || ''
        });
      }

      if (c.type === 'icp_promote' || c.type === 'icp_demote') {
        var j = -1;
        for (var k = 0; k < icps.length; k++) {
          if (icps[k] && icps[k].name === c.target) { j = k; break; }
        }
        if (j > -1) {
          var item = icps.splice(j, 1)[0];
          item.rankChangedWeek = weekNumber;
          item.rankReason      = c.reason || '';
          if (c.type === 'icp_promote') icps.unshift(item);
          else icps.push(item);
        }
      }

      if (c.type === 'action_update' && Array.isArray(c.content)) {
        out.thisWeekActions = { week: weekNumber, actions: c.content };
      }
    });

    tab1.icps     = icps;
    tab2.messages = msgs;
    out.tab1      = tab1;
    out.tab2      = tab2;
    out.lastPatchedWeek = weekNumber;
  } catch (e) {
    console.error('applyCheckinPatch failed:', e);
    return plan;
  }
  return out;

  /* Resolve a message by icp name first, falling back to index */
  function findIdx(arr, icpName, idx) {
    if (icpName) {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].icp === icpName && arr[i].status !== 'retired') return i;
      }
    }
    if (typeof idx === 'number' && arr[idx]) return idx;
    return -1;
  }
}

/* Round-trips the stored scoutOutput STRING through applyCheckinPatch().
   scoutOutput is stored as a raw string (possibly fence-wrapped), so we must
   clean → parse → patch → stringify. Fail-safe: returns the ORIGINAL string
   unchanged if anything goes wrong. Never throws. */
function applyPatchToStoredPlan(rawPlanString, patch, weekNumber) {
  if (!rawPlanString || typeof rawPlanString !== 'string') return rawPlanString;
  if (!patch) return rawPlanString;
  try {
    /* Same cleaning pipeline parseAndRender() uses */
    var cleaned = rawPlanString
      .replace(/^```json\s*/im, '')
      .replace(/^```\s*/im, '')
      .replace(/```\s*$/im, '')
      .trim();
    var first = cleaned.indexOf('{');
    var last  = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return rawPlanString;
    cleaned = cleaned.slice(first, last + 1);

    var planObj = JSON.parse(cleaned);
    if (!planObj || !planObj.tab1) return rawPlanString;  /* not a TYPE-1 plan */

    var patched = applyCheckinPatch(planObj, patch, weekNumber);
    if (!patched || patched === planObj) return rawPlanString;  /* nothing applied */
    if (!patched.tab1 || !patched.tab2) return rawPlanString;   /* sanity guard */

    return JSON.stringify(patched);
  } catch (e) {
    console.error('applyPatchToStoredPlan failed, plan left unchanged:', e);
    return rawPlanString;
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

  // Strip separator lines before parsing (Scout uses ===, ━━━ etc.)
  var cleanText = text
    .replace(/^[=\-━═]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  // Revenue Velocity — Scout outputs heading then value on next line:
  //   REVENUE VELOCITY
  //   ₹45,000 added/month
  var rvPatterns = [
    /REVENUE\s+VELOCITY\s*\n\s*(₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?(?:[\/\s]*(?:added\/month|month|per month))?)/i,
    /REVENUE\s+VELOCITY[\s\S]{0,100}(₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?(?:\s*\/\s*month|\s*per\s*month|\s*added\/month))/i,
    /₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?\s*added\/month/i,
    /₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?(?:\s*\/\s*month|\s*per\s*month)/i
  ];
  for (var ri = 0; ri < rvPatterns.length; ri++) {
    var rvM = cleanText.match(rvPatterns[ri]);
    if (rvM) {
      revenueVelocity = (rvM[1] || rvM[0]).trim();
      if (!revenueVelocity.startsWith('₹')) revenueVelocity = '₹' + revenueVelocity;
      break;
    }
  }

  // Acquisition Efficiency — Scout outputs heading then value on next line:
  //   ACQUISITION EFFICIENCY
  //   12 contacts needed per new customer
  var aePatterns = [
    /ACQUISITION\s+EFFICIENCY\s*\n\s*(\d+)\s+contacts?/i,
    /ACQUISITION\s+EFFICIENCY[\s\S]{0,100}(\d+)\s+contacts?\s+(?:needed|per)/i,
    /(\d+)\s+contacts?\s+(?:needed|per)\s+(?:per\s*)?(?:new\s*)?customer/i,
    /ACQUISITION\s+EFFICIENCY[\s\S]{0,100}(\d+)\s+contacts/i,
    /(\d+)\s+contacts?\s+needed/i
  ];
  for (var ai = 0; ai < aePatterns.length; ai++) {
    var aeM = cleanText.match(aePatterns[ai]);
    if (aeM) { acquisitionEff = aeM[1] + ' contacts'; break; }
  }

  // Momentum Score — Scout outputs: SCOUT MOMENTUM: 45/100
  var msPatterns = [
    /SCOUT\s+MOMENTUM\s*[:\-]\s*(\d+)/i,
    /MOMENTUM\s*[:\-]\s*(\d+)\/100/i,
    /(\d+)\/100\s*(?:momentum|score)/i,
    /(?:scout\s+)?momentum(?:\s+score)?[:\s]+(\d{1,3})(?:\/(?:10|100))?/i
  ];
  for (var mi = 0; mi < msPatterns.length; mi++) {
    var msM = cleanText.match(msPatterns[mi]);
    if (msM) {
      var score = parseInt(msM[1], 10);
      if (score >= 0 && score <= 100) { momentumScore = score; break; }
    }
  }

  // Momentum Note — text after the score number
  var mnMatch = cleanText.match(/SCOUT\s+MOMENTUM[:\s]+\d+(?:\/100)?[:\s—\-]+([^\n]+)/i);
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
