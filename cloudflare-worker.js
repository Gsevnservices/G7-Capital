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
// ─────────────────────────────────────────────────────────────────────────────

// Allowed origins — requests from any other origin are rejected
const ALLOWED_ORIGINS = [
  'https://gsevnservices.github.io',
  'http://localhost:8080'
];

// The Anthropic endpoint this worker proxies to
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// ─────────────────────────────────────────────────────────────────────────────
// CORS HEADERS
// Returns the correct CORS headers for a given request origin.
// If the origin is not in the allowed list, returns no CORS headers
// (browser will block the request).
// ─────────────────────────────────────────────────────────────────────────────
function getCorsHeaders(requestOrigin) {
  const origin = ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

    // Handle CORS preflight (browser sends OPTIONS before the real POST)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only accept POST requests to /api/message
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/api/message') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

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

    // Forward to Anthropic — API key is added here server-side,
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

    // Pass Anthropic's response back to the browser, with CORS headers added
    const responseBody = await anthropicResponse.text();
    return new Response(responseBody, {
      status: anthropicResponse.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
};
