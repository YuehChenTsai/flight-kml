// =============================================================
// Cloudflare Pages Function — OpenSky API 代理
// 用途：解決 CORS + 隱藏 credentials
//
// 部署後設定環境變數（Cloudflare Dashboard → Settings → Environment variables）：
//   OPENSKY_CLIENT_ID     = ray1010987-api-client
//   OPENSKY_CLIENT_SECRET = （你的 secret）
// =============================================================

const OPENSKY_API = 'https://opensky-network.org/api';
const OPENSKY_AUTH = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

// 簡易 token 快取（Worker 記憶體層級，cold start 會重新取）
let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken(env) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const clientId = env.OPENSKY_CLIENT_ID;
  const clientSecret = env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing OPENSKY_CLIENT_ID or OPENSKY_CLIENT_SECRET in environment variables.');
  }

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
    throw new Error(`Token request failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  const expiresIn = data.expires_in || 1800;
  tokenExpiresAt = now + (expiresIn - 120) * 1000; // 提前 2 分鐘更新
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
  const { request, env, params } = context;
  const origin = request.headers.get('Origin') || '*';

  // 處理 preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // 只允許 GET
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: corsHeaders(origin),
    });
  }

  try {
    // 從路徑取得 OpenSky API 路徑
    // 例如 /api/flights/departure?airport=RCTP&begin=...
    //   → params.path = ["flights", "departure"]
    const pathSegments = params.path || [];
    const apiPath = '/' + pathSegments.join('/');

    // 允許的端點白名單
    const allowedPrefixes = ['/flights/', '/tracks/', '/states/'];
    const isAllowed = allowedPrefixes.some(p => apiPath.startsWith(p));
    if (!isAllowed) {
      return new Response(JSON.stringify({ error: 'Endpoint not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // 取得 token
    const token = await getToken(env);

    // 轉送 query string
    const url = new URL(request.url);
    const targetUrl = `${OPENSKY_API}${apiPath}${url.search}`;

    const apiResp = await fetch(targetUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    // 轉送回應
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
