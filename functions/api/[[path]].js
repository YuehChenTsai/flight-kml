// =============================================================
// Cloudflare Pages Function — OpenSky API 代理 (v2 debug)
// =============================================================

const OPENSKY_API = 'https://opensky-network.org/api';
const OPENSKY_AUTH = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken(clientId, clientSecret) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const resp = await fetch(OPENSKY_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenSky token failed (${resp.status}): ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  const expiresIn = data.expires_in || 1800;
  tokenExpiresAt = now + (expiresIn - 120) * 1000;
  return cachedToken;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  const params = context.params;
  const origin = request.headers.get('Origin') || '*';

  // preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405, headers: corsHeaders(origin),
    });
  }

  try {
    // 讀取環境變數
    const clientId = env.OPENSKY_CLIENT_ID;
    const clientSecret = env.OPENSKY_CLIENT_SECRET;

    // 除錯：列出 env 中有哪些 key（不洩漏值）
    if (!clientId || !clientSecret) {
      const envKeys = Object.keys(env || {}).join(', ');
      return new Response(JSON.stringify({
        error: 'Missing credentials',
        detail: `OPENSKY_CLIENT_ID is ${clientId ? 'set' : 'MISSING'}, OPENSKY_CLIENT_SECRET is ${clientSecret ? 'set' : 'MISSING'}`,
        envKeys: envKeys || '(env is empty)',
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // 路徑
    const pathSegments = params.path || [];
    const apiPath = '/' + pathSegments.join('/');

    // 白名單
    const allowedPrefixes = ['/flights/', '/tracks/', '/states/'];
    if (!allowedPrefixes.some(p => apiPath.startsWith(p))) {
      return new Response(JSON.stringify({ error: `Endpoint not allowed: ${apiPath}` }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // 取 token
    const token = await getToken(clientId, clientSecret);

    // 轉送
    const url = new URL(request.url);
    const targetUrl = `${OPENSKY_API}${apiPath}${url.search}`;

    const apiResp = await fetch(targetUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const body = await apiResp.text();
    return new Response(body, {
      status: apiResp.status,
      headers: {
        'Content-Type': apiResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(origin),
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}
