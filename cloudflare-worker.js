// ─────────────────────────────────────────────────────────────────────────────
// G7 Capital — Cloudflare Worker
// Multi-user auth + per-firm KV storage + Anthropic API proxy
//
// KV namespace: G7_WORKSPACE → bound as G7_KV
//
// Environment variables required:
//   ANTHROPIC_API_KEY  — Anthropic API key (set in Cloudflare dashboard)
//   ADMIN_PASSWORD     — Password for /admin/* routes (set in Cloudflare dashboard)
//
// KV key schema:
//   auth:users:{FIRMCODE}            → { firmName, passwordHash, createdAt, tier }
//   auth:sessions:{token}            → { firmCode, firmName, createdAt, expiresAt }
//   firms:{FIRMCODE}:config          → firm configuration object
//   firms:{FIRMCODE}:kb              → firm knowledge base text
//   firms:{FIRMCODE}:deals           → array of screened deals
//   firms:{FIRMCODE}:calibrations    → array of partner corrections
//
// Route map:
//   POST /api/message            — Anthropic proxy (session-protected)
//   POST /auth/login             — Login with firmCode + password
//   POST /auth/logout            — Invalidate session token
//   GET  /auth/validate          — Check if session token is still valid
//   POST /data/save              — Save firm data to KV (session-protected)
//   GET  /data/load              — Load firm data from KV (session-protected)
//   POST /admin/create-firm      — Create a new firm account (admin-protected)
//   GET  /admin/list-firms       — List all firm accounts (admin-protected)
//   POST /admin/reset-password   — Reset a firm's password (admin-protected)
//   GET  /admin/firm-usage       — Get deal usage count for a firm (admin-protected)
//   POST /admin/reset-usage      — Reset deal usage counter for a firm (admin-protected)
//
// Health check:
//   GET /                        → { status: 'G7 Proxy is running' }
// ─────────────────────────────────────────────────────────────────────────────

// The Anthropic endpoint this worker proxies to
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: CORS HEADERS
// All responses must include these so GitHub Pages (a different origin)
// can read the response. The wildcard '*' is safe here because every
// sensitive route is protected by session token or admin password.
// ─────────────────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: JSON RESPONSE
// Wraps a JSON body with status code and CORS headers.
// ─────────────────────────────────────────────────────────────────────────────
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: HASH PASSWORD
// SHA-256 hashes a plain-text password and returns a hex string.
// Used during firm creation and login verification.
// ─────────────────────────────────────────────────────────────────────────────
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: VALIDATE SESSION
// Reads the Authorization: Bearer {token} header, looks up the session
// in KV, checks expiry, and returns the session object if valid.
// Returns null if the token is missing, invalid, or expired.
// ─────────────────────────────────────────────────────────────────────────────
async function validateSession(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7); // strip 'Bearer '
  const session = await env.G7_KV.get('auth:sessions:' + token, 'json');
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    // Token has expired — clean it up and reject
    await env.G7_KV.delete('auth:sessions:' + token);
    return null;
  }
  return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {

    // Normalise pathname — strip trailing slash so /auth/login and
    // /auth/login/ both match
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // ── CORS preflight ────────────────────────────────────────────────────────
    // Browser sends OPTIONS before every cross-origin request.
    // Must respond 204 with CORS headers or the real request will be blocked.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ── Health check ─────────────────────────────────────────────────────────
    // GET / returns a simple alive signal. Useful for verifying the worker
    // is deployed and reachable without needing auth.
    if (request.method === 'GET' && path === '/') {
      return jsonResponse({ status: 'G7 Proxy is running' });
    }

    // =========================================================================
    // ROUTE 1 — POST /api/message
    // Anthropic API proxy. Adds API key server-side so it is never
    // exposed to the browser. Session token required.
    // =========================================================================
    if (request.method === 'POST' && path === '/api/message') {

      // Validate session before proxying — reject unauthenticated requests
      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized — valid session token required' }, 401);
      }

      // Parse and validate the request body
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      // ── Deal usage limit ──────────────────────────────────────────────────────
      // Only check and increment on the FIRST call of a deal submission
      // (messages.length === 1). Subsequent tool_use continuation calls
      // have more messages and are part of the same deal — do not count them.
      const DEAL_LIMIT = 50;
      const isFirstCall = Array.isArray(body.messages) && body.messages.length === 1;

      if (isFirstCall) {
        const usageKey = 'usage:' + session.firmCode + ':deals';
        const currentUsage = await env.G7_KV.get(usageKey, 'json') || { count: 0 };

        if (currentUsage.count >= DEAL_LIMIT) {
          return jsonResponse({
            error:   'deal_limit_reached',
            message: 'Your firm has reached the ' + DEAL_LIMIT + ' deal limit for the ' +
                     'beta period. Contact your G7 Capital administrator to increase your limit.',
            count:   currentUsage.count,
            limit:   DEAL_LIMIT
          }, 429);
        }
      }

      // Enforce max_uses: 2 on any web_search tool — server-side cap
      // that cannot be overridden by editing browser code.
      if (body.tools && Array.isArray(body.tools)) {
        body.tools = body.tools.map(tool => {
          if (tool.type === 'web_search_20250305' || tool.name === 'web_search') {
            return { ...tool, max_uses: 2 };
          }
          return tool;
        });
      }

      // Forward to Anthropic — API key added here server-side,
      // never visible to the browser
      let anthropicResponse;
      try {
        anthropicResponse = await fetch(ANTHROPIC_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-search-2025-03-05'
          },
          body: JSON.stringify(body)
        });
      } catch {
        return jsonResponse({ error: 'Failed to reach Anthropic API' }, 502);
      }

      // Read Anthropic's response body once (streams can only be read once)
      const responseBody = await anthropicResponse.text();

      // Increment deal counter only on a successful first call
      // Fire-and-forget — do not let a KV write delay the response
      if (isFirstCall && anthropicResponse.ok) {
        const usageKey = 'usage:' + session.firmCode + ':deals';
        const currentUsage = await env.G7_KV.get(usageKey, 'json') || { count: 0 };
        env.G7_KV.put(usageKey, JSON.stringify({
          count:    currentUsage.count + 1,
          lastUsed: Date.now(),
          firmCode: session.firmCode
        })); // intentionally not awaited — best-effort, does not block response
      }

      // Return Anthropic's response to the browser with CORS headers
      return new Response(responseBody, {
        status: anthropicResponse.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // =========================================================================
    // ROUTE 2 — POST /auth/login
    // Validates firmCode + password, creates a 7-day session token in KV,
    // returns the token to the client for use in subsequent requests.
    // =========================================================================
    if (request.method === 'POST' && path === '/auth/login') {

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { firmCode, password } = body;
      if (!firmCode || !password) {
        return jsonResponse({ error: 'firmCode and password are required' }, 400);
      }

      // Normalize firmCode to uppercase so G7CAP and g7cap both work
      const normalizedCode = firmCode.toUpperCase().trim();

      // Look up the firm in KV
      const user = await env.G7_KV.get('auth:users:' + normalizedCode, 'json');
      if (!user) {
        // Return same error message as wrong password — prevents user enumeration
        return jsonResponse({ error: 'Invalid credentials' }, 401);
      }

      // Hash the submitted password and compare to stored hash
      const submittedHash = await hashPassword(password);
      if (submittedHash !== user.passwordHash) {
        return jsonResponse({ error: 'Invalid credentials' }, 401);
      }

      // Generate a session token — two UUIDs joined for extra length
      const token = crypto.randomUUID() + '-' + crypto.randomUUID();

      // Store session in KV with 7-day TTL
      // expiresAt is checked on each request; Cloudflare also auto-deletes
      // the key after expirationTtl seconds as a backup cleanup mechanism
      await env.G7_KV.put(
        'auth:sessions:' + token,
        JSON.stringify({
          firmCode: normalizedCode,
          firmName: user.firmName,
          createdAt: Date.now(),
          expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days in ms
        }),
        { expirationTtl: 604800 } // 7 days in seconds — Cloudflare TTL
      );

      return jsonResponse({
        token,
        firmCode: normalizedCode,
        firmName: user.firmName
      });
    }

    // =========================================================================
    // ROUTE 3 — POST /auth/logout
    // Deletes the session token from KV, invalidating it immediately.
    // =========================================================================
    if (request.method === 'POST' && path === '/auth/logout') {

      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return jsonResponse({ error: 'No session token provided' }, 400);
      }

      const token = authHeader.slice(7);

      // Delete the session — if it doesn't exist, that's fine (idempotent)
      await env.G7_KV.delete('auth:sessions:' + token);

      return jsonResponse({ success: true });
    }

    // =========================================================================
    // ROUTE 4 — GET /auth/validate
    // Checks whether a session token is still valid and returns firm identity.
    // Used by the frontend on page load to restore session state.
    // =========================================================================
    if (request.method === 'GET' && path === '/auth/validate') {

      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ valid: false }, 401);
      }

      return jsonResponse({
        valid: true,
        firmCode: session.firmCode,
        firmName: session.firmName
      });
    }

    // =========================================================================
    // ROUTE 5 — POST /data/save
    // Saves firm data to KV under the firm's own namespace.
    // Session required — firms can only write to their own keys.
    //
    // Valid types and resulting KV keys:
    //   'config'       → firms:{CODE}:config
    //   'kb'           → firms:{CODE}:kb
    //   'deals'        → firms:{CODE}:deals
    //   'calibrations' → firms:{CODE}:calibrations
    // =========================================================================
    if (request.method === 'POST' && path === '/data/save') {

      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized — valid session token required' }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { type, data } = body;

      // Validate type — only these four are accepted
      const validTypes = ['config', 'kb', 'deals', 'calibrations'];
      if (!type || !validTypes.includes(type)) {
        return jsonResponse({
          error: 'Invalid type. Must be one of: config, kb, deals, calibrations'
        }, 400);
      }

      // Construct the KV key scoped to this firm
      const key = 'firms:' + session.firmCode + ':' + type;

      // Save to KV — no TTL on firm data, it persists until explicitly deleted
      await env.G7_KV.put(key, JSON.stringify(data));

      return jsonResponse({ success: true });
    }

    // =========================================================================
    // ROUTE 6 — GET /data/load
    // Loads firm data from KV by type.
    // Session required — firms can only read their own keys.
    //
    // Query parameter: ?type=config (or kb, deals, calibrations)
    // Returns: { data: <value> } or { data: null } if not yet saved
    // =========================================================================
    if (request.method === 'GET' && path === '/data/load') {

      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized — valid session token required' }, 401);
      }

      const type = url.searchParams.get('type');

      // Validate type
      const validTypes = ['config', 'kb', 'deals', 'calibrations'];
      if (!type || !validTypes.includes(type)) {
        return jsonResponse({
          error: 'Invalid type. Must be one of: config, kb, deals, calibrations'
        }, 400);
      }

      // Construct the KV key scoped to this firm
      const key = 'firms:' + session.firmCode + ':' + type;

      // Load from KV — returns null if the key does not exist yet
      const raw = await env.G7_KV.get(key, 'json');

      return jsonResponse({ data: raw || null });
    }

    // =========================================================================
    // ROUTE 7 — POST /admin/create-firm
    // Creates a new firm account in KV.
    // Protected by ADMIN_PASSWORD environment variable — not a session token.
    // =========================================================================
    if (request.method === 'POST' && path === '/admin/create-firm') {

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { adminPassword, firmCode, firmName, password } = body;

      // Validate admin password against environment variable
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      // Validate required fields
      if (!firmCode || !firmName || !password) {
        return jsonResponse({ error: 'firmCode, firmName, and password are required' }, 400);
      }

      // Normalize firmCode to uppercase
      const normalizedCode = firmCode.toUpperCase().trim();

      // Hash the firm's login password for storage
      const passwordHash = await hashPassword(password);

      // Store the firm user record in KV
      await env.G7_KV.put(
        'auth:users:' + normalizedCode,
        JSON.stringify({
          firmName,
          passwordHash,
          createdAt: Date.now(),
          tier: 'beta'
        })
      );

      // Initialise empty firm data stores so /data/load always returns
      // an array (never null) for these two high-frequency keys
      await env.G7_KV.put(
        'firms:' + normalizedCode + ':deals',
        JSON.stringify([])
      );
      await env.G7_KV.put(
        'firms:' + normalizedCode + ':calibrations',
        JSON.stringify([])
      );

      return jsonResponse({
        success: true,
        firmCode: normalizedCode,
        firmName
      });
    }

    // =========================================================================
    // ROUTE 8 — GET /admin/list-firms
    // Returns a list of all firm accounts in KV.
    // Protected by ?adminPassword=xxx query parameter.
    // =========================================================================
    if (request.method === 'GET' && path === '/admin/list-firms') {

      const adminPassword = url.searchParams.get('adminPassword');

      // Validate admin password
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      // List all keys with the 'auth:users:' prefix to find all firm accounts
      const list = await env.G7_KV.list({ prefix: 'auth:users:' });

      // Fetch each firm's data to return a useful summary
      const firms = await Promise.all(
        list.keys.map(async (key) => {
          const user = await env.G7_KV.get(key.name, 'json');
          // Extract firmCode from the key name by stripping 'auth:users:' prefix
          const firmCode = key.name.replace('auth:users:', '');
          return {
            firmCode,
            firmName: user ? user.firmName : 'Unknown',
            createdAt: user ? user.createdAt : null,
            tier: user ? user.tier : null
          };
        })
      );

      return jsonResponse({ firms });
    }

    // ── ROUTE 9 — POST /admin/reset-password ──────────────────────────────────
    if (request.method === 'POST' && path === '/admin/reset-password') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

      const { adminPassword, firmCode, newPassword } = body;

      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      const normalizedCode = (firmCode || '').toUpperCase().trim();
      if (!normalizedCode) {
        return jsonResponse({ error: 'firmCode is required' }, 400);
      }
      if (!newPassword || newPassword.length < 6) {
        return jsonResponse({ error: 'newPassword must be at least 6 characters' }, 400);
      }

      const user = await env.G7_KV.get('auth:users:' + normalizedCode, 'json');
      if (!user) {
        return jsonResponse({ error: 'Firm not found: ' + normalizedCode }, 404);
      }

      const newHash = await hashPassword(newPassword);
      await env.G7_KV.put('auth:users:' + normalizedCode, JSON.stringify({
        ...user,
        passwordHash: newHash,
        passwordResetAt: Date.now()
      }));

      return jsonResponse({ success: true, firmCode: normalizedCode });
    }

    // ── ROUTE 10 — GET /admin/firm-usage ──────────────────────────────────────
    // Returns the deal usage count for a specific firm.
    // Query params: firmCode, adminPassword
    if (request.method === 'GET' && path === '/admin/firm-usage') {
      const adminPassword = url.searchParams.get('adminPassword');
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      const firmCode = (url.searchParams.get('firmCode') || '').toUpperCase().trim();
      if (!firmCode) {
        return jsonResponse({ error: 'firmCode query parameter is required' }, 400);
      }

      const usageKey = 'usage:' + firmCode + ':deals';
      const usage = await env.G7_KV.get(usageKey, 'json') || { count: 0 };

      return jsonResponse({
        firmCode,
        count:    usage.count,
        limit:    50,
        lastUsed: usage.lastUsed || null
      });
    }

    // ── ROUTE 11 — POST /admin/reset-usage ────────────────────────────────────
    // Resets the deal usage counter for a specific firm to zero.
    // Body: { adminPassword, firmCode }
    if (request.method === 'POST' && path === '/admin/reset-usage') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

      const { adminPassword, firmCode } = body;
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      const normalizedCode = (firmCode || '').toUpperCase().trim();
      if (!normalizedCode) {
        return jsonResponse({ error: 'firmCode is required' }, 400);
      }

      await env.G7_KV.delete('usage:' + normalizedCode + ':deals');

      return jsonResponse({ success: true, firmCode: normalizedCode });
    }

    // ── Catch-all 404 ─────────────────────────────────────────────────────────
    return jsonResponse({ error: 'Not found' }, 404);
  }
};
