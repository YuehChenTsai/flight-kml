// Cloudflare Pages Function — airplanes.live trace 代理 (CORS proxy)
// 只允許代理 traces/ 路徑，無需任何 API key

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

  // 處理 CORS 預檢
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  try {
    const pathSegments = params.path || [];
    const apiPath = pathSegments.join('/');

    // 只允許代理 traces/ 開頭的路徑
    if (!apiPath.startsWith('traces/')) {
      return new Response(JSON.stringify({ error: 'Path not allowed: ' + apiPath }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // 代理到 globe.airplanes.live
    const targetUrl = 'https://globe.airplanes.live/data/' + apiPath;
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FlightKML/1.0)',
      },
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: 'Upstream error: ' + resp.status }), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const body = await resp.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
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
