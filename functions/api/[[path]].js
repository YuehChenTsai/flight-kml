// =============================================================
// Cloudflare Pages Function — adsb.fi trace 代理
// 用途：只解決 globe.adsb.fi 的 CORS 問題，不需任何認證
// =============================================================

const ALLOWED_ORIGINS = [
  'https://globe.adsb.fi',
];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export async function onRequest(context) {
  const { request, params } = context;
  const origin = request.headers.get('Origin') || '*';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
  }

  try {
    const pathSegments = params.path || [];
    const apiPath = pathSegments.join('/');

    // 白名單：只允許 traces 路徑
    if (!apiPath.startsWith('traces/')) {
      return new Response(JSON.stringify({ error: 'Not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const targetUrl = `https://globe.adsb.fi/data/${apiPath}`;
    const resp = await fetch(targetUrl);
    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'public, max-age=10',
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
