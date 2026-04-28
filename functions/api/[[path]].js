// functions/api/[[path]].js
// Cloudflare Pages Functions — 統一 API 代理（修正版）

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

// 帶 User-Agent 和 Referer 的 fetch，避免被目標伺服器擋
async function proxyFetch(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FlightKML/1.0)',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
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
      const resp = await proxyFetch(target);
      if (!resp.ok) return errorResponse(`Upstream error: ${resp.status}`, resp.status);
      const data = await resp.text();
      return corsResponse(data);
    }

    // ============================================================
    // 2) /api/history/{source}/{YYYY}/{MM}/{DD}/{hex2}/{hex}.json
    //    → 歷史 trace（globe_history 端點）
    //    支援多來源備援：若指定 source=auto 則依序嘗試
    // ============================================================
    if (route === 'history') {
      const SOURCES = {
        airplaneslive: 'https://globe.airplanes.live/globe_history',
        adsblol: 'https://globe.adsb.lol/globe_history',
        adsbfi: 'https://globe.adsb.fi/globe_history',
        adsbx: 'https://globe.adsbexchange.com/globe_history',
        theairtraffic: 'https://globe.theairtraffic.com/globe_history',
      };

      const AUTO_ORDER = ['airplaneslive', 'adsblol', 'theairtraffic', 'adsbfi', 'adsbx'];

      if (segments.length < 7) {
        return errorResponse('Format: /api/history/{source}/{YYYY}/{MM}/{DD}/{hex2}/{hex}.json');
      }

      const source = segments[1];
      const yyyy = segments[2];
      const mm = segments[3];
      const dd = segments[4];
      const hex2 = segments[5];
      const filename = segments[6];

      if (!/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd)) {
        return errorResponse('Invalid date format');
      }
      if (!/^[0-9a-f]{2}$/i.test(hex2)) {
        return errorResponse('Invalid hex2 folder');
      }
      if (!/^trace_full_[0-9a-f]+\.json$/i.test(filename)) {
        return errorResponse('Invalid trace filename');
      }

      const buildUrl = (src) => {
        const base = SOURCES[src];
        return `${base}/${yyyy}/${mm}/${dd}/traces/${hex2}/${filename}`;
      };

      // auto 模式：依序嘗試所有來源
      if (source === 'auto') {
        const errors = [];
        for (const src of AUTO_ORDER) {
          try {
            const target = buildUrl(src);
            const resp = await proxyFetch(target, 12000);
            if (resp.ok) {
              const data = await resp.text();
              // 在回應中加入來源資訊
              return corsResponse(data, 200, 'application/json');
            }
            errors.push(`${src}:${resp.status}`);
          } catch (e) {
            errors.push(`${src}:${e.message}`);
          }
        }
        return errorResponse(`所有資料來源均失敗: ${errors.join(', ')}`, 502);
      }

      // 指定來源
      const baseUrl = SOURCES[source];
      if (!baseUrl) {
        return errorResponse(`Unknown source: ${source}. Valid: ${Object.keys(SOURCES).join(', ')}, auto`);
      }

      const target = buildUrl(source);
      const resp = await proxyFetch(target);
      if (!resp.ok) {
        return errorResponse(`Source ${source} returned ${resp.status}`, resp.status);
      }
      const data = await resp.text();
      return corsResponse(data);
    }

    // ============================================================
    // 3) /api/hexdb/...
    //    → 代理 hexdb.io API
    // ============================================================
    if (route === 'hexdb') {
      const subPath = segments.slice(1).join('/');
      if (!subPath) return errorResponse('Missing hexdb path');

      const query = url.search || '';
      const fullSub = subPath + query;
      const target = `https://hexdb.io/${fullSub}`;
      const resp = await proxyFetch(target);
      if (!resp.ok) return errorResponse(`hexdb returned ${resp.status}`, resp.status);
      const data = await resp.text();
      const ct = resp.headers.get('Content-Type') || 'text/plain';
      return corsResponse(data, 200, ct);
    }

    // ============================================================
    // 4) /api/opensky/...
    //    → 代理 OpenSky API
    // ============================================================
    if (route === 'opensky') {
      const subPath = segments.slice(1).join('/');
      if (!subPath) return errorResponse('Missing opensky path');

      const query = url.search || '';
      const target = `https://opensky-network.org/api/${subPath}${query}`;
      const resp = await proxyFetch(target, 20000);
      if (!resp.ok) return errorResponse(`OpenSky returned ${resp.status}`, resp.status);
      const data = await resp.text();
      return corsResponse(data);
    }

    // ============================================================
    // 5) /api/airplaneslive/...
    //    → 代理 airplanes.live REST API
    // ============================================================
    if (route === 'airplaneslive') {
      const subPath = segments.slice(1).join('/');
      if (!subPath) return errorResponse('Missing airplaneslive path');

      const target = `https://api.airplanes.live/v2/${subPath}`;
      const resp = await proxyFetch(target);
      if (!resp.ok) return errorResponse(`airplanes.live returned ${resp.status}`, resp.status);
      const data = await resp.text();
      return corsResponse(data);
    }

    // ============================================================
    // 6) /api/health/{service}
    // ============================================================
    if (route === 'health') {
      const service = segments[1];

      async function check(checkUrl, timeout = 8000) {
        try {
          const resp = await proxyFetch(checkUrl, timeout);
          return { ok: resp.status < 500, status: resp.status };
        } catch {
          return { ok: false, status: 0 };
        }
      }

      if (service === 'all') {
        const [airplaneslive, adsblol, hexdb, opensky] = await Promise.all([
          check('https://api.airplanes.live/v2/hex/000000'),
          check('https://globe.adsb.lol/globe_history/2026/01/01/traces/00/trace_full_000000.json'),
          check('https://hexdb.io/api/v1/aircraft/000000'),
          check('https://opensky-network.org/api/time'),
        ]);
        return corsResponse(JSON.stringify({ airplaneslive, adsblol, hexdb, opensky }));
      }

      const checks = {
        airplaneslive: 'https://api.airplanes.live/v2/hex/000000',
        adsblol: 'https://globe.adsb.lol/globe_history/2026/01/01/traces/00/trace_full_000000.json',
        hexdb: 'https://hexdb.io/api/v1/aircraft/000000',
        opensky: 'https://opensky-network.org/api/time',
      };

      const checkUrl = checks[service];
      if (!checkUrl) {
        return errorResponse(`Unknown service. Valid: ${Object.keys(checks).join(', ')}, all`);
      }

      const result = await check(checkUrl);
      return corsResponse(JSON.stringify(result));
    }

    return errorResponse(`Unknown route: ${route}`);
  } catch (e) {
    return errorResponse(`Server error: ${e.message}`, 500);
  }
}
