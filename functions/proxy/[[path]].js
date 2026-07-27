// functions/proxy/[[path]].js

// --- 配置 (现在从 Cloudflare 环境变量读取) ---
// 在 Cloudflare Pages 设置 -> 函数 -> 环境变量绑定 中设置以下变量:
// CACHE_TTL (例如 86400)
// MAX_RECURSION (例如 5)
// FILTER_DISCONTINUITY (不再需要，设为 false 或移除)
// USER_AGENTS_JSON (例如 ["UA1", "UA2"]) - JSON 字符串数组
// DEBUG (例如 false 或 true)
// PASSWORD (例如 "your_password") - 鉴权密码
// --- 配置结束 ---

// --- 常量 (之前在 config.js 中，现在移到这里，因为它们与代理逻辑相关) ---
const MEDIA_FILE_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    '.m4s', '.cmfv', '.cmfa', '.mp4a', '.key',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];
// --- 常量结束 ---


/**
 * 主要的 Pages Function 处理函数
 * 拦截发往 /proxy/* 的请求
 */
export async function onRequest(context) {
    const { request, env, next, waitUntil } = context; // next 和 waitUntil 可能需要
    const url = new URL(request.url);

    // 验证鉴权（主函数调用）
    const isValidAuth = await validateAuth(request, env);
    if (!isValidAuth) {
        return new Response(JSON.stringify({
            success: false,
            error: '代理访问未授权：请检查密码配置或鉴权参数'
        }), { 
            status: 401,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Content-Type': 'application/json'
            }
        });
    }

    // --- 从环境变量读取配置 ---
    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400'); // 默认 24 小时
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5'); // 默认 5 层
    // 广告过滤已移至播放器处理，代理不再执行
    let USER_AGENTS = [ // 提供一个基础的默认值
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    try {
        // 尝试从环境变量解析 USER_AGENTS_JSON
        const agentsJson = env.USER_AGENTS_JSON;
        if (agentsJson) {
            const parsedAgents = JSON.parse(agentsJson);
            if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
                USER_AGENTS = parsedAgents;
            } else {
                 logDebug("环境变量 USER_AGENTS_JSON 格式无效或为空，使用默认值");
            }
        }
    } catch (e) {
        logDebug(`解析环境变量 USER_AGENTS_JSON 失败: ${e.message}，使用默认值`);
    }
    // --- 配置读取结束 ---


    // --- 辅助函数 ---

    // 验证代理请求的鉴权
    async function validateAuth(request, env) {
        const url = new URL(request.url);
        const authHash = url.searchParams.get('auth');
        const timestamp = url.searchParams.get('t');
        
        // 获取服务器端密码
        const serverPassword = env.PASSWORD;
        if (!serverPassword) {
            console.error('服务器未设置 PASSWORD 环境变量，代理访问被拒绝');
            return false;
        }
        
        // 使用 SHA-256 哈希算法（与其他平台保持一致）
        // 在 Cloudflare Workers 中使用 crypto.subtle
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(serverPassword);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const serverPasswordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            
            if (!authHash || authHash !== serverPasswordHash) {
                console.warn('代理请求鉴权失败：密码哈希不匹配');
                return false;
            }
        } catch (error) {
            console.error('计算密码哈希失败:', error);
            return false;
        }
        
        // 验证时间戳（10分钟有效期）
        if (timestamp) {
            const now = Date.now();
            const maxAge = 10 * 60 * 1000; // 10分钟
            if (now - parseInt(timestamp) > maxAge) {
                console.warn('代理请求鉴权失败：时间戳过期');
                return false;
            }
        }
        
        return true;
    }

    // 输出调试日志 (需要设置 DEBUG: true 环境变量)
    function logDebug(message) {
        if (DEBUG_ENABLED) {
            console.log(`[Proxy Func] ${message}`);
        }
    }

    // 从请求路径中提取目标 URL
    function getTargetUrlFromPath(pathname) {
        // 路径格式: /proxy/经过编码的URL
        // 例如: /proxy/https%3A%2F%2Fexample.com%2Fplaylist.m3u8
        const encodedUrl = pathname.replace(/^\/proxy\//, '');
        if (!encodedUrl) return null;
        try {
            // 解码
            let decodedUrl = decodeURIComponent(encodedUrl);

             // 简单检查解码后是否是有效的 http/https URL
             if (!decodedUrl.match(/^https?:\/\//i)) {
                 // 也许原始路径就没有编码？如果看起来像URL就直接用
                 if (encodedUrl.match(/^https?:\/\//i)) {
                     decodedUrl = encodedUrl;
                     logDebug(`Warning: Path was not encoded but looks like URL: ${decodedUrl}`);
                 } else {
                    logDebug(`无效的目标URL格式 (解码后): ${decodedUrl}`);
                    return null;
                 }
             }
             return decodedUrl;

        } catch (e) {
            logDebug(`解码目标URL时出错: ${encodedUrl} - ${e.message}`);
            return null;
        }
    }

    // 创建标准化的响应
    function createResponse(body, status = 200, headers = {}) {
        const responseHeaders = new Headers(headers);
        // 关键：添加 CORS 跨域头，允许前端 JS 访问代理后的响应
        responseHeaders.set("Access-Control-Allow-Origin", "*"); // 允许任何来源访问
        responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS"); // 允许的方法
        responseHeaders.set("Access-Control-Allow-Headers", "*"); // 允许所有请求头

        // 处理 CORS 预检请求 (OPTIONS) - 放在这里确保所有响应都处理
         if (request.method === "OPTIONS") {
             // 使用下面的 onOptions 函数可以更规范，但在这里处理也可以
             return new Response(null, {
                 status: 204, // No Content
                 headers: responseHeaders // 包含上面设置的 CORS 头
             });
         }

        return new Response(body, { status, headers: responseHeaders });
    }

    // 创建 M3U8 类型的响应
    function createM3u8Response(content) {
        return createResponse(content, 200, {
            "Content-Type": "application/vnd.apple.mpegurl", // M3U8 的标准 MIME 类型
            // Playlists commonly contain expiring signatures or live windows.
            "Cache-Control": "no-store"
        });
    }

    function createUpstreamResponse(response) {
        const headers = new Headers(response.headers);
        headers.delete('Content-Disposition');
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers', '*');
        return new Response(request.method === 'HEAD' ? null : response.body, {
            status: response.status,
            statusText: response.statusText,
            headers
        });
    }

    // 获取随机 User-Agent
    function getRandomUserAgent() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    // 获取 URL 的基础路径 (用于解析相对路径)
    function getBaseUrl(urlStr) {
        try {
            const parsedUrl = new URL(urlStr);
            // 如果路径是根目录，或者没有斜杠，直接返回 origin + /
            if (!parsedUrl.pathname || parsedUrl.pathname === '/') {
                return `${parsedUrl.origin}/`;
            }
            const pathParts = parsedUrl.pathname.split('/');
            pathParts.pop(); // 移除文件名或最后一个路径段
            return `${parsedUrl.origin}${pathParts.join('/')}/`;
        } catch (e) {
            logDebug(`获取 BaseUrl 时出错: ${urlStr} - ${e.message}`);
            // 备用方法：找到最后一个斜杠
            const lastSlashIndex = urlStr.lastIndexOf('/');
            // 确保不是协议部分的斜杠 (http://)
            return lastSlashIndex > urlStr.indexOf('://') + 2 ? urlStr.substring(0, lastSlashIndex + 1) : urlStr + '/';
        }
    }


    // 将相对 URL 转换为绝对 URL
    function resolveUrl(baseUrl, relativeUrl) {
        // 如果已经是绝对 URL，直接返回
        if (relativeUrl.match(/^https?:\/\//i)) {
            return relativeUrl;
        }
        try {
            // 使用 URL 对象来处理相对路径
            return new URL(relativeUrl, baseUrl).toString();
        } catch (e) {
            logDebug(`解析 URL 失败: baseUrl=${baseUrl}, relativeUrl=${relativeUrl}, error=${e.message}`);
            // 简单的备用方法
            if (relativeUrl.startsWith('/')) {
                // 处理根路径相对 URL
                const urlObj = new URL(baseUrl);
                return `${urlObj.origin}${relativeUrl}`;
            }
            // 处理同级目录相对 URL
            return `${baseUrl.replace(/\/[^/]*$/, '/')}${relativeUrl}`; // 确保baseUrl以 / 结尾
        }
    }

    // 将目标 URL 重写为内部代理路径 (/proxy/...)
    function rewriteUrlToProxy(targetUrl) {
        // 确保目标URL被正确编码，以便作为路径的一部分
        const proxyPath = `/proxy/${encodeURIComponent(targetUrl)}`;
        const authHash = url.searchParams.get('auth');
        return authHash ? `${proxyPath}?auth=${encodeURIComponent(authHash)}` : proxyPath;
    }

    function isM3u8Url(targetUrl) {
        try {
            return new URL(targetUrl).pathname.toLowerCase().endsWith('.m3u8');
        } catch (error) {
            return /\.m3u8(?:[?#]|$)/i.test(targetUrl || '');
        }
    }

    // 获取远程内容及其类型
    async function fetchContentWithType(targetUrl) {
        const headers = new Headers({
            'User-Agent': getRandomUserAgent(),
            'Accept': '*/*',
            'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
            // Sending the LibreTV page as Referer triggers anti-hotlink rules.
            'Referer': `${new URL(targetUrl).origin}/`
        });
        const range = request.headers.get('Range');
        const ifRange = request.headers.get('If-Range');
        if (range) headers.set('Range', range);
        if (ifRange) headers.set('If-Range', ifRange);

        try {
            // 直接请求目标 URL
            logDebug(`开始直接请求: ${targetUrl}`);
            // Cloudflare Functions 的 fetch 默认支持重定向
            const response = await fetch(targetUrl, {
                headers,
                redirect: 'follow',
                method: request.method === 'HEAD' ? 'HEAD' : 'GET'
            });

            if (!response.ok) {
                 const errorBody = await response.text().catch(() => '');
                 logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
                 throw new Error(`HTTP error ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 150)}`);
            }

            const finalUrl = response.url || targetUrl;
            const contentType = response.headers.get('Content-Type') || '';
            const isPlaylist = isM3u8Url(targetUrl)
                || isM3u8Url(finalUrl)
                || /(?:mpegurl|m3u8)/i.test(contentType);
            const content = isPlaylist && request.method !== 'HEAD'
                ? await response.text()
                : null;
            logDebug(`请求成功: ${targetUrl}, 最终URL: ${finalUrl}, Content-Type: ${contentType}`);
            return {
                content,
                contentType,
                response,
                responseHeaders: response.headers,
                finalUrl,
                isPlaylist
            };

        } catch (error) {
             logDebug(`请求彻底失败: ${targetUrl}: ${error.message}`);
            // 抛出更详细的错误
            throw new Error(`请求目标URL失败 ${targetUrl}: ${error.message}`);
        }
    }

    // 判断是否是 M3U8 内容
    function isM3u8Content(content, contentType) {
        // 检查 Content-Type
        if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
            return true;
        }
        // 检查内容本身是否以 #EXTM3U 开头
        return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
    }

    // 判断是否是媒体文件 (根据扩展名和 Content-Type) - 这部分在此代理中似乎未使用，但保留
    function isMediaFile(url, contentType = '') {
        const normalizedType = contentType.split(';', 1)[0].trim().toLowerCase();

        // Some providers incorrectly label playlists as video/*; keep M3U8
        // responses as text so their URLs can still be rewritten.
        if (normalizedType.includes('mpegurl') || normalizedType.includes('m3u8')) {
            return false;
        }
        if (MEDIA_CONTENT_TYPES.some(mediaType => normalizedType.startsWith(mediaType))) {
            return true;
        }

        // Query strings and fragments are not part of a file extension.
        // URL.pathname handles encoded URLs while the fallback covers malformed
        // target strings that cannot be parsed as absolute URLs.
        let pathname = url;
        try {
            pathname = new URL(url).pathname;
        } catch {
            pathname = url.split(/[?#]/, 1)[0];
        }
        const pathnameLower = pathname.toLowerCase();
        return MEDIA_FILE_EXTENSIONS.some(ext => pathnameLower.endsWith(ext));
    }

    // 处理 M3U8 中的 #EXT-X-KEY 行 (加密密钥)
    function processKeyLine(line, baseUrl) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const absoluteUri = resolveUrl(baseUrl, uri);
            logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
            return `URI="${rewriteUrlToProxy(absoluteUri)}"`; // 重写为代理路径
        });
    }

    // 处理 M3U8 中的 #EXT-X-MAP 行 (初始化片段)
    function processMapLine(line, baseUrl) {
         return line.replace(/URI="([^"]+)"/, (match, uri) => {
             const absoluteUri = resolveUrl(baseUrl, uri);
             logDebug(`处理 MAP URI: 原始='${uri}', 绝对='${absoluteUri}'`);
             return `URI="${rewriteUrlToProxy(absoluteUri)}"`; // 重写为代理路径
         });
     }

    // 处理媒体 M3U8 播放列表 (包含视频/音频片段)
    function processMediaPlaylist(url, content) {
        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        const output = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // 保留最后的空行
            if (!line && i === lines.length - 1) {
                output.push(line);
                continue;
            }
            if (!line) continue; // 跳过中间的空行

            if (line.startsWith('#EXT-X-KEY')) {
                output.push(processKeyLine(line, baseUrl));
                continue;
            }
            if (line.startsWith('#EXT-X-MAP')) {
                output.push(processMapLine(line, baseUrl));
                 continue;
            }
            if (line.startsWith('#') && line.includes('URI="')) {
                output.push(line.replace(/URI="([^"]+)"/g, (match, uri) => {
                    return `URI="${rewriteUrlToProxy(resolveUrl(baseUrl, uri))}"`;
                }));
                continue;
            }
             if (line.startsWith('#EXTINF')) {
                 output.push(line);
                 continue;
             }
             if (!line.startsWith('#')) {
                 const absoluteUrl = resolveUrl(baseUrl, line);
                 logDebug(`重写媒体片段: 原始='${line}', 绝对='${absoluteUrl}'`);
                 output.push(rewriteUrlToProxy(absoluteUrl));
                 continue;
             }
             // 其他 M3U8 标签直接添加
             output.push(line);
        }
        return output.join('\n');
    }

    // 递归处理 M3U8 内容
     async function processM3u8Content(targetUrl, content, recursionDepth = 0, env) {
         if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
             logDebug(`检测到主播放列表: ${targetUrl}`);
             return await processMasterPlaylist(targetUrl, content, recursionDepth, env);
         }
         logDebug(`检测到媒体播放列表: ${targetUrl}`);
         return processMediaPlaylist(targetUrl, content);
     }

    // 处理主 M3U8 播放列表
    async function processMasterPlaylist(url, content, recursionDepth, env) {
        if (recursionDepth > MAX_RECURSION) {
            throw new Error(`处理主列表时递归层数过多 (${MAX_RECURSION}): ${url}`);
        }

        const baseUrl = getBaseUrl(url);
        const rewriteMasterUri = (uri) => {
            if (!uri || /^(?:data|skd):/i.test(uri)) return uri;
            return rewriteUrlToProxy(resolveUrl(baseUrl, uri));
        };

        // Preserve every rendition so HLS.js can start at a TV-friendly
        // bitrate and adapt upward instead of forcing the highest variant.
        return content.split('\n').map((originalLine) => {
            const line = originalLine.trim();
            if (!line) return originalLine;
            if (!line.startsWith('#')) return rewriteMasterUri(line);
            return originalLine.replace(/URI="([^"]+)"/g, (match, uri) => {
                return `URI="${rewriteMasterUri(uri)}"`;
            });
        }).join('\n');
    }

    // --- 主要请求处理逻辑 ---

    try {
        const targetUrl = getTargetUrlFromPath(url.pathname);

        if (!targetUrl) {
            logDebug(`无效的代理请求路径: ${url.pathname}`);
            return createResponse("无效的代理请求。路径应为 /proxy/<经过编码的URL>", 400);
        }

        logDebug(`收到代理请求: ${targetUrl}`);

        // --- 缓存检查 (KV) ---
        const cacheKey = `proxy_raw_v2:${targetUrl}`; // 使用原始内容的缓存键
        // Remote APIs and playlists frequently carry short-lived URLs. Keep
        // the existing KV binding available, but bypass stale raw responses.
        const canUseTextCache = false;
        let kvNamespace = null;
        try {
            kvNamespace = env.LIBRETV_PROXY_KV;
            if (!kvNamespace) throw new Error("KV 命名空间未绑定");
        } catch (e) {
            logDebug(`KV 命名空间 'LIBRETV_PROXY_KV' 访问出错或未绑定: ${e.message}`);
            kvNamespace = null;
        }

        if (kvNamespace && canUseTextCache) {
            try {
                const cachedDataJson = await kvNamespace.get(cacheKey); // 直接获取字符串
                if (cachedDataJson) {
                    logDebug(`[缓存命中] 原始内容: ${targetUrl}`);
                    const cachedData = JSON.parse(cachedDataJson); // 解析 JSON
                    const content = cachedData.body;
                    let headers = {};
                    try { headers = JSON.parse(cachedData.headers); } catch(e){} // 解析头部
                    const contentType = headers['content-type'] || headers['Content-Type'] || '';

                    if (isM3u8Content(content, contentType)) {
                        logDebug(`缓存内容是 M3U8，重新处理: ${targetUrl}`);
                        const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env);
                        return createM3u8Response(processedM3u8);
                    } else {
                        logDebug(`从缓存返回非 M3U8 内容: ${targetUrl}`);
                        const cachedHeaders = new Headers(headers);
                        cachedHeaders.delete('Content-Length');
                        cachedHeaders.delete('Content-Encoding');
                        cachedHeaders.delete('Transfer-Encoding');
                        cachedHeaders.delete('Content-Disposition');
                        return createResponse(content, 200, cachedHeaders);
                    }
                } else {
                     logDebug(`[缓存未命中] 原始内容: ${targetUrl}`);
                 }
            } catch (kvError) {
                 logDebug(`从 KV 读取或解析缓存失败 (${cacheKey}): ${kvError.message}`);
                 // 出错则继续执行，不影响功能
            }
        }

        // --- 实际请求 ---
        const {
            content,
            contentType,
            response,
            responseHeaders,
            finalUrl,
            isPlaylist
        } = await fetchContentWithType(targetUrl);

        // --- 写入缓存 (KV) ---
        if (kvNamespace && canUseTextCache && content !== null) {
             try {
                 const headersToCache = {};
                 responseHeaders.forEach((value, key) => { headersToCache[key.toLowerCase()] = value; });
                 const cacheValue = { body: content, headers: JSON.stringify(headersToCache) };
                 // 注意 KV 写入限制
                 waitUntil(kvNamespace.put(cacheKey, JSON.stringify(cacheValue), { expirationTtl: CACHE_TTL }));
                 logDebug(`已将原始内容写入缓存: ${targetUrl}`);
            } catch (kvError) {
                 logDebug(`向 KV 写入缓存失败 (${cacheKey}): ${kvError.message}`);
                 // 写入失败不影响返回结果
            }
        }

        // --- 处理响应 ---
        if (request.method !== 'HEAD' && isPlaylist && isM3u8Content(content, contentType)) {
            logDebug(`内容是 M3U8，开始处理: ${finalUrl}`);
            const processedM3u8 = await processM3u8Content(finalUrl, content, 0, env);
            return createM3u8Response(processedM3u8);
        }

        if (content !== null) {
            const textHeaders = new Headers(responseHeaders);
            textHeaders.delete('Content-Length');
            textHeaders.delete('Content-Encoding');
            return createResponse(content, response.status, textHeaders);
        }

        logDebug(`内容不是 M3U8 (类型: ${contentType})，按原始字节流返回: ${finalUrl}`);
        return createUpstreamResponse(response);

    } catch (error) {
        logDebug(`处理代理请求时发生严重错误: ${error.message} \n ${error.stack}`);
        return createResponse(`代理处理错误: ${error.message}`, 500);
    }
}

// 处理 OPTIONS 预检请求的函数
export async function onOptions(context) {
    // 直接返回允许跨域的头信息
    return new Response(null, {
        status: 204, // No Content
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*", // 允许所有请求头
            "Access-Control-Max-Age": "86400", // 预检请求结果缓存一天
        },
    });
}
