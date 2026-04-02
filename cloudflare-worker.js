// ─────────────────────────────────────────────────────────────────────────────
// G7 Capital — Cloudflare Worker Proxy
// Routes requests from GitHub Pages to api.anthropic.com
//
// Deploy steps:
//   1. Go to dash.cloudflare.com → Workers & Pages → Create Worker
//   2. Paste this file
//   3. Add environment variable: ANTHROPIC_API_KEY = your key
//   4. Deploy and copy your worker URL
//   5. Replace the placeholder URL in assets/workspace.js
//
// Environment variables required:
//   ANTHROPIC_API_KEY — your Anthropic API key (set in Cloudflare dashboard,
//                       never exposed to the browser)
//
// Test the worker is alive:
//   GET https://g7-proxy.gsevnservices.workers.dev/
//   → {"status":"G7 Proxy is running"}
//
// Send a deal screening request:
//   POST https://g7-proxy.gsevnservices.workers.dev/api/message
//   Body: standard Anthropic messages API JSON (without x-api-key)
// ─────────────────────────────────────────────────────────────────────────────

// Allowed origins for CORS — requests from any other origin are rejected
const ALLOWED_ORIGINS = [
  'https://gsevnservices.github.io',
  'http://localhost:8080'
];

// The Anthropic endpoint this worker proxies to
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// ─────────────────────────────────────────────────────────────────────────────
// CORS HEADERS
// Returns CORS headers scoped to the requesting origin.
// Falls back to the first allowed origin if the requesting origin is unknown.
// ─────────────────────────────────────────────────────────────────────────────
function getCorsHeaders(requestOrigin) {
  const origin = ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = getCorsHeaders(origin);

    // Normalise pathname — strip trailing slash so /api/message and
    // /api/message/ both match
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // ── CORS preflight ────────────────────────────────────────────────────────
    // Browser sends OPTIONS before every cross-origin POST — must respond 204
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Health check ─────────────────────────────────────────────────────────
    // GET to any path returns a simple alive signal.
    // Useful for verifying the worker deployed and is reachable.
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'G7 Proxy is running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ── Route: POST /api/message ──────────────────────────────────────────────
    if (request.method === 'POST' && path === '/api/message') {

      // Reject requests from disallowed origins
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Read and validate the request body
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
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
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(body)
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Failed to reach Anthropic API' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Return Anthropic's response to the browser, with CORS headers added
      const responseBody = await anthropicResponse.text();
      return new Response(responseBody, {
        status: anthropicResponse.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ── Catch-all 404 ─────────────────────────────────────────────────────────
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};
