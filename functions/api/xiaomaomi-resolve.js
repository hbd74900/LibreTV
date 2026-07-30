import {
    resolveXiaomaomiSource,
    validateXiaomaomiSourceUrl,
    XiaomaomiResolveError
} from '../_shared/xiaomaomi.js';

const CACHE_SECONDS = 300;

function jsonResponse(payload, status = 200, cacheControl = 'no-store') {
    return new Response(status === 204 ? null : JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': cacheControl,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}

async function validateAuth(request, password) {
    if (!password) return false;
    const url = new URL(request.url);
    const auth = url.searchParams.get('auth');
    const timestamp = Number(url.searchParams.get('t'));
    if (!auth || !Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
        return false;
    }

    const bytes = new TextEncoder().encode(password);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const expected = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    return auth === expected;
}

export async function onRequest(context) {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return jsonResponse({}, 204);
    if (request.method !== 'POST') return jsonResponse({ code: 405, msg: '仅支持 POST 请求' }, 405);
    if (!await validateAuth(request, env.PASSWORD)) {
        return jsonResponse({ code: 401, msg: '解析请求鉴权失败' }, 401);
    }

    let sourceUrl;
    try {
        const body = await request.json();
        sourceUrl = validateXiaomaomiSourceUrl(body && body.url);
    } catch (error) {
        const status = error instanceof XiaomaomiResolveError ? error.status : 400;
        return jsonResponse({ code: status, msg: error.message || '请求内容格式无效' }, status);
    }

    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheUrl = new URL('/__xiaomaomi_cache__', request.url);
    cacheUrl.searchParams.set('url', sourceUrl);
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    if (cache) {
        const cached = await cache.match(cacheKey);
        if (cached) return jsonResponse(await cached.json());
    }

    try {
        const media = await resolveXiaomaomiSource(sourceUrl);
        const payload = { code: 200, ...media };
        if (cache) {
            const cacheResponse = jsonResponse(payload, 200, `public, max-age=${CACHE_SECONDS}`);
            context.waitUntil(cache.put(cacheKey, cacheResponse));
        }
        return jsonResponse(payload);
    } catch (error) {
        const status = error instanceof XiaomaomiResolveError ? error.status : 502;
        return jsonResponse({ code: status, msg: error.message || '小猫咪解析失败' }, status);
    }
}
