// functions/api/[[path]].js
// Cloudflare Pages Functions — 統一 API 代理

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body, status = 200, contentType = 'application/json') {
  return new Response(body, {
    status,
    headers: { 'Content-Type': contentType, ...CORS_HEADERS },
  });
}

function errorResponse(msg, status = 400) {
  return corsResponse(JSON.stringify({ error: msg }), status);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const fullPath = url.pathname.replace(/^\/api\//, '');
  const segments = fullPath.split('/').filter(Boolean);

  if (segments.length === 0) {
    return errorResponse('Missing API path');
  }

  const route = segments[0];

  try {
    // ============================================================
    // 1) /api/traces/{hex2}/trace_full_{hex}.json
    //    → 即時 trace（airplanes.live）
    // ============================================================
    if (route === 'traces') {
      const tracePath = segments.slice(1).join('/');
      if (!/^[0-9a-f]{2}\/trace_(full|recent)_[0-9a-f]+\.json$/i.test(tracePath)) {
        return errorResponse('Invalid trace path');
      }
      const target = `https://globe.airplanes.live/data/traces/${tracePath}`;
      const resp = await fetch(target);
      if (!resp.ok) return errorResponse(`Upstream error: ${resp.status}`, resp.status);
      const data = await resp.text();
      return corsResponse(data);
    }

    // ============================================================
    // 2) /api/history/{source}/{YYYY}/{MM}/{DD}/{hex2}/{hex}.json
    //    → 歷史 trace（globe_history 端點）
    //    source: airplaneslive | adsblol | adsbfi | adsbx | theairtraffic
    // ============================================================
    if (route === 'history') {
      const SOURCES = {
        airplaneslive: 'https://globe.airplanes.live/globe_history',
        adsblol: 'https://globe.adsb.lol/globe_history',
        adsbfi: 'https://globe.adsb.fi/globe_history',
        adsbx: 'https://globe.adsbexchange.com/globe_history',
        theairtraffic: 'https://globe.theairtraffic.com/globe_history',
      };

      // segments: history / {source} / {YYYY} / {MM} / {DD} / {hex2} / {hex}.json
      if (segments.length < 7) {
        return errorResponse('Format: /api/history/{source}/{YYYY}/{MM}/{DD}/{hex2}/{hex}.json');
      }

      const source = segments[1];
      const baseUrl = SOURCES[source];
      if (!baseUrl) {
        return errorResponse(`Unknown source: ${source}. Valid: ${Object.keys(SOURCES).join(', ')}`);
      }

      const yyyy = segments[2];
      const mm = segments[3];
      const dd = segments[4];
      const hex2 = segments[5];
      const filename = segments[6]; // trace_full_{hex}.json

      // 驗證格式
      if (!/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd)) {
        return errorResponse('Invalid date format');
      }
      if (!/^[0-9a-f]{2}$/i.test(hex2)) {
        return errorResponse('Invalid hex2 folder');
      }
      if (!/^trace_full_[0-9a-f]+\.json$/i.test(filename)) {
        return errorResponse('Invalid trace filename');
      }

      const target = `${baseUrl}/${yyyy}/${mm}/${dd}/traces/${hex2}/${filename}`;
      const resp = await fetch(target);
      if (!resp.ok) {
        return errorResponse(`Source ${source} returned ${resp.status}`, resp.status);
      }
      const data = await resp.text();
      return corsResponse(data);
    }

    // ============================================================
    // 3) /api/hexdb/{sub-path}
    //    → 代理 hexdb.io API
    // ============================================================
    if (route === 'hexdb') {
      const subPath = segments.slice(1).join('/');
      if (!subPath) return errorResponse('Missing hexdb path');

      // 允許的端點白名單
      const allowed = [
        /^reg-hex\?reg=.+$/i,
        /^api\/v1\/aircraft\/[0-9a-f]+$/i,
        /^api\/v1\/route\/icao\/.+$/i,
        /^api\/v1\/route\/iata\/.+$/i,
        /^api\/v1\/airport\/icao\/[A-Z]{4}$/i,
        /^api\/v1\/airport\/iata\/[A-Z]{3}$/i,
        /^hex-type\?hex=[0-9a-f]+$/i,
      ];

      const query = url.search || '';
      const fullSub = subPath + query;

      const isAllowed = allowed.some(re => re.test(fullSub));
      if (!isAllowed) {
        return errorResponse('hexdb path not allowed');
      }

      const target = `https://hexdb.io/${fullSub}`;
      const resp = await fetch(target);
      if (!resp.ok) return errorResponse(`hexdb returned ${resp.status}`, resp.status);
      const data = await resp.text();
      const ct = resp.headers.get('Content-Type') || 'text/plain';
      return corsResponse(data, 200, ct);
    }

    // ============================================================
    // 4) /api/opensky/{sub-path}
    //    → 代理 OpenSky API
    // ============================================================
    if (route === 'opensky') {
      const subPath = segments.slice(1).join('/');
      if (!subPath) return errorResponse('Missing opensky path');

      const query = url.search || '';
      const target = `https://opensky-network.org/api/${subPath}${query}`;
      const resp = await fetch(target);
      if (!resp.ok) return errorResponse(`OpenSky returned ${resp.status}`, resp.status);
      const data = await resp.text();
      return corsResponse(data);
    }

    // ============================================================
    // 5) /api/airplaneslive/{sub-path}
    //    → 代理 airplanes.live REST API（即時查詢）
    // ============================================================
    if (route === 'airplaneslive') {
      const subPath = segments.slice(1).join('/');
      if (!subPath) return errorResponse('Missing airplaneslive path');

      const target = `https://api.airplanes.live/v2/${subPath}`;
      const resp = await fetch(target);
      if (!resp.ok) return errorResponse(`airplanes.live returned ${resp.status}`, resp.status);
      const data = await resp.text();
      return corsResponse(data);
    }

    // ============================================================
    // 6) /api/health/{service}
    //    → 健康檢查
    // ============================================================
    if (route === 'health') {
      const service = segments[1];
      const checks = {
        airplaneslive: 'https://api.airplanes.live/v2/hex/000000',
        adsblol: 'https://globe.adsb.lol/globe_history/2026/01/01/traces/00/trace_full_000000.json',
        hexdb: 'https://hexdb.io/api/v1/aircraft/000000',
        opensky: 'https://opensky-network.org/api/time',
      };

      if (service === 'all') {
        const results = {};
        await Promise.all(
          Object.entries(checks).map(async ([name, checkUrl]) => {
            try {
              const r = await fetch(checkUrl, { signal: AbortSignal.timeout(8000) });
              results[name] = { ok: r.status < 500, status: r.status };
            } catch {
              results[name] = { ok: false, status: 0 };
            }
          })
        );
        return corsResponse(JSON.stringify(results));
      }

      const checkUrl = checks[service];
      if (!checkUrl) {
        return errorResponse(`Unknown service: ${service}. Valid: ${Object.keys(checks).join(', ')}, all`);
      }

      try {
        const r = await fetch(checkUrl, { signal: AbortSignal.timeout(8000) });
        return corsResponse(JSON.stringify({ ok: r.status < 500, status: r.status }));
      } catch {
        return corsResponse(JSON.stringify({ ok: false, status: 0 }));
      }
    }

    return errorResponse(`Unknown route: ${route}`);
  } catch (e) {
    return errorResponse(`Server error: ${e.message}`, 500);
  }
}
