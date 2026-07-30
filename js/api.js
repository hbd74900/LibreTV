// 改进的API请求处理函数
const IKANBOT_SOURCE_KEY = 'ikanbot';
const XIAOMAOMI_SOURCE_KEY = 'xiaomaomi';

function isIkanbotSource(sourceCode) {
    return sourceCode === IKANBOT_SOURCE_KEY
        && API_SITES[sourceCode]
        && API_SITES[sourceCode].special === IKANBOT_SOURCE_KEY;
}

function isXiaomaomiSource(sourceCode) {
    return sourceCode === XIAOMAOMI_SOURCE_KEY
        && API_SITES[sourceCode]
        && API_SITES[sourceCode].special === XIAOMAOMI_SOURCE_KEY;
}

function parseEpisodeGroup(playSource, directOnly = false) {
    return String(playSource || '').split('#').map(part => {
        const delimiter = part.indexOf('$');
        return (delimiter >= 0 ? part.substring(delimiter + 1) : part).trim();
    }).filter(mediaUrl => {
        if (!/^https?:\/\//i.test(mediaUrl)) return false;
        return !directOnly || /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(mediaUrl);
    });
}

function isXiaomaomiEpisodeUrl(mediaUrl) {
    try {
        const hostname = new URL(mediaUrl).hostname.toLowerCase();
        return ['qq.com', 'iqiyi.com', 'youku.com', 'bilibili.com', 'mgtv.com']
            .some(host => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
        return false;
    }
}

function selectXiaomaomiEpisodes(videoDetail) {
    const candidates = String(videoDetail.vod_play_url || '').split('$$$')
        .map(group => {
            const parts = String(group || '').split('#');
            const episodes = parseEpisodeGroup(group).filter(isXiaomaomiEpisodeUrl);
            const numberedEpisodes = parts.filter(part => {
                const label = part.split('$', 1)[0].trim();
                return /^(?:第\s*)?\d+(?:\s*[集话期])?$|^(?:ep|e)\s*\d+$/i.test(label);
            }).length;
            return { episodes, numberedEpisodes };
        })
        .filter(candidate => candidate.episodes.length > 0);

    const serialCandidates = candidates
        .filter(candidate => candidate.numberedEpisodes >= 2)
        .sort((left, right) => right.numberedEpisodes - left.numberedEpisodes
            || right.episodes.length - left.episodes.length);
    return (serialCandidates[0] || candidates[0] || {}).episodes || [];
}

function selectPlayableEpisodes(videoDetail) {
    const playGroups = String(videoDetail.vod_play_url || '').split('$$$');
    const providerNames = String(videoDetail.vod_play_from || '').split('$$$');
    const candidates = playGroups.map((group, index) => {
        const episodes = parseEpisodeGroup(group);
        const directEpisodes = parseEpisodeGroup(group, true);
        const providerName = providerNames[index] || '';
        const providerClaimsDirectMedia = /(?:m3u8|mp4)/i.test(providerName);
        return {
            index,
            episodes,
            directEpisodes,
            isDirect: directEpisodes.length > 0 || providerClaimsDirectMedia,
            score: directEpisodes.length * 1000
                + (providerClaimsDirectMedia ? 100 : 0)
                + episodes.length
        };
    });

    const directCandidates = candidates
        .filter(candidate => candidate.isDirect && candidate.episodes.length > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);
    if (directCandidates.length > 0) {
        const selected = directCandidates[0];
        return selected.directEpisodes.length > 0 ? selected.directEpisodes : selected.episodes;
    }

    const fallback = candidates.find(candidate => candidate.episodes.length > 0);
    return fallback ? fallback.episodes : [];
}

async function fetchIkanbotContent(targetUrl, responseType = 'text') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
        const proxyPath = PROXY_URL + encodeURIComponent(targetUrl);
        const proxiedUrl = window.ProxyAuth && window.ProxyAuth.addAuthToProxyUrl
            ? await window.ProxyAuth.addAuthToProxyUrl(proxyPath)
            : proxyPath;
        const response = await fetch(proxiedUrl, {
            headers: {
                'Accept': responseType === 'json'
                    ? 'application/json, text/plain, */*'
                    : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`爱看机器人请求失败: ${response.status}`);
        }
        return responseType === 'json' ? response.json() : response.text();
    } finally {
        clearTimeout(timeoutId);
    }
}

function parseIkanbotDocument(html) {
    const documentNode = new DOMParser().parseFromString(html, 'text/html');
    if (documentNode.title.includes('Attention Required') || documentNode.querySelector('#cf-error-details')) {
        throw new Error('爱看机器人暂时拒绝了请求');
    }
    return documentNode;
}

function parseIkanbotSearchResults(html, sourceCode = IKANBOT_SOURCE_KEY) {
    const documentNode = parseIkanbotDocument(html);
    const sourceName = API_SITES[sourceCode].name;
    const seenIds = new Set();
    const results = [];

    documentNode.querySelectorAll('a.title-text[href*="/play/"]').forEach(anchor => {
        const idMatch = (anchor.getAttribute('href') || '').match(/\/play\/(\d+)/);
        if (!idMatch || seenIds.has(idMatch[1])) return;

        const card = anchor.closest('.media') || anchor.parentElement;
        const image = card ? card.querySelector('img[data-src], img') : null;
        const label = card ? card.querySelector('.label') : null;
        const smallText = card
            ? Array.from(card.querySelectorAll('.small')).map(element => element.textContent.trim()).filter(Boolean)
            : [];
        const rawTitle = anchor.textContent.trim();
        const yearMatch = rawTitle.match(/(?:19|20)\d{2}(?!.*(?:19|20)\d{2})/);
        const title = (image && image.getAttribute('alt') || rawTitle.replace(/\s+(?:19|20)\d{2}\s*$/, '')).trim();
        const cover = image && (image.getAttribute('data-src') || image.getAttribute('src')) || '';

        seenIds.add(idMatch[1]);
        results.push({
            vod_id: idMatch[1],
            vod_name: title,
            vod_pic: /^https?:\/\//i.test(cover) ? cover : '',
            vod_remarks: label ? label.textContent.trim().replace(/^\[|\]$/g, '') : '',
            vod_year: yearMatch ? yearMatch[0] : '',
            vod_area: smallText[0] || '',
            vod_actor: smallText[1] || '',
            type_name: '影视',
            source_name: sourceName,
            source_code: sourceCode
        });
    });

    return results;
}

async function searchIkanbotByKeyword(query, sourceCode = IKANBOT_SOURCE_KEY) {
    const baseUrl = API_SITES[sourceCode].api.replace(/\/$/, '');
    const html = await fetchIkanbotContent(`${baseUrl}/search?q=${encodeURIComponent(query)}`);
    return parseIkanbotSearchResults(html, sourceCode);
}

function makeIkanbotToken(videoId, encryptedToken) {
    let remaining = String(encryptedToken || '');
    const output = [];
    const suffix = String(videoId || '').slice(-4);
    if (!/^\d{4}$/.test(suffix) || !remaining) {
        throw new Error('爱看机器人播放令牌参数缺失');
    }

    for (const digit of suffix) {
        const start = Number(digit) % 3 + 1;
        if (remaining.length < start + 8) {
            throw new Error('爱看机器人播放令牌格式已变化');
        }
        output.push(remaining.substring(start, start + 8));
        remaining = remaining.substring(start + 8);
    }
    return output.join('');
}

function parseIkanbotEpisodeGroup(group) {
    if (!group || typeof group.url !== 'string') return [];
    return group.url.split('#').map(part => {
        const delimiter = part.indexOf('$');
        return (delimiter >= 0 ? part.substring(delimiter + 1) : part).trim();
    }).filter(mediaUrl => /^https?:\/\//i.test(mediaUrl)
        && /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(mediaUrl));
}

function selectIkanbotEpisodes(providers) {
    const candidates = [];
    for (const provider of providers || []) {
        try {
            const groups = JSON.parse(provider.resData || '[]');
            for (const group of Array.isArray(groups) ? groups : [groups]) {
                const episodes = parseIkanbotEpisodeGroup(group);
                if (episodes.length > 0) candidates.push(episodes);
            }
        } catch (error) {
            console.warn('爱看机器人线路解析失败:', error);
        }
    }
    candidates.sort((left, right) => right.length - left.length);
    return candidates[0] || [];
}

async function handleIkanbotDetail(id, sourceCode = IKANBOT_SOURCE_KEY) {
    const site = API_SITES[sourceCode];
    const baseUrl = site.api.replace(/\/$/, '');
    const detailUrl = `${baseUrl}/play/${encodeURIComponent(id)}`;
    const html = await fetchIkanbotContent(detailUrl);
    const documentNode = parseIkanbotDocument(html);
    const fieldValue = fieldId => {
        const element = documentNode.getElementById(fieldId);
        return element ? String(element.value || '').trim() : '';
    };
    const currentId = fieldValue('current_id');
    const mediaType = fieldValue('mtype');
    const token = makeIkanbotToken(currentId, fieldValue('e_token'));
    const resourceUrl = `${baseUrl}/api/getResN?videoId=${encodeURIComponent(currentId)}`
        + `&mtype=${encodeURIComponent(mediaType)}&token=${encodeURIComponent(token)}`;
    const resourceData = await fetchIkanbotContent(resourceUrl, 'json');

    if (!resourceData || resourceData.state !== 1 || !resourceData.data) {
        throw new Error(resourceData && resourceData.message || '爱看机器人没有返回播放线路');
    }

    const providers = Array.isArray(resourceData.data.list) ? resourceData.data.list : [];
    const episodes = selectIkanbotEpisodes(providers);
    const titleElement = documentNode.getElementById('video_title');
    const infoRoot = documentNode.querySelector('.item.result-info .detail');
    const metadata = infoRoot
        ? Array.from(infoRoot.querySelectorAll('h3.meta')).map(element => element.textContent.trim())
        : [];
    const coverElement = documentNode.querySelector('.item.result-info img[data-src], .item.result-info img');
    const cover = coverElement && (coverElement.getAttribute('data-src') || coverElement.getAttribute('src')) || '';
    const castParts = (metadata[3] || '').split('/');

    return JSON.stringify({
        code: 200,
        episodes,
        detailUrl,
        videoInfo: {
            title: titleElement ? titleElement.textContent.trim() : '',
            cover: /^https?:\/\//i.test(cover) ? cover : '',
            desc: metadata[0] || '',
            type: '影视',
            year: metadata[1] || '',
            area: metadata[2] || '',
            director: castParts[0] || '',
            actor: castParts.slice(1).join('/') || '',
            remarks: providers.length ? `${providers.length} 条可选线路，已自动选择集数最完整的线路` : '',
            source_name: site.name,
            source_code: sourceCode
        }
    });
}

async function handleApiRequest(url) {
    const customApi = url.searchParams.get('customApi') || '';
    const customDetail = url.searchParams.get('customDetail') || '';
    const source = url.searchParams.get('source') || 'heimuer';
    
    try {
        if (url.pathname === '/api/search') {
            const searchQuery = url.searchParams.get('wd');
            if (!searchQuery) {
                throw new Error('缺少搜索参数');
            }
            
            // 验证API和source的有效性
            if (source === 'custom' && !customApi) {
                throw new Error('使用自定义API时必须提供API地址');
            }
            
            if (isIkanbotSource(source)) {
                const results = await searchIkanbotByKeyword(searchQuery, source);
                return JSON.stringify({ code: 200, list: results });
            }

            if (!API_SITES[source] && source !== 'custom') {
                throw new Error('无效的API来源');
            }
            
            const apiUrl = customApi
                ? `${customApi}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`
                : `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            
            // 添加超时处理
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            try {
                // 添加鉴权参数到代理URL
                const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                    await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl)) :
                    PROXY_URL + encodeURIComponent(apiUrl);
                    
                const response = await fetch(proxiedUrl, {
                    headers: API_CONFIG.search.headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`API请求失败: ${response.status}`);
                }
                
                const data = await response.json();
                
                // 检查JSON格式的有效性
                if (!data || !Array.isArray(data.list)) {
                    throw new Error('API返回的数据格式无效');
                }
                
                // 添加源信息到每个结果
                data.list.forEach(item => {
                    item.source_name = source === 'custom' ? '自定义源' : API_SITES[source].name;
                    item.source_code = source;
                    // 对于自定义源，添加API URL信息
                    if (source === 'custom') {
                        item.api_url = customApi;
                    }
                });
                
                return JSON.stringify({
                    code: 200,
                    list: data.list || [],
                });
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
        }

        // 详情处理
        if (url.pathname === '/api/detail') {
            const id = url.searchParams.get('id');
            const sourceCode = url.searchParams.get('source') || 'heimuer'; // 获取源代码
            
            if (!id) {
                throw new Error('缺少视频ID参数');
            }
            
            // 验证ID格式 - 只允许数字和有限的特殊字符
            if (!/^[\w-]+$/.test(id)) {
                throw new Error('无效的视频ID格式');
            }

            // 验证API和source的有效性
            if (sourceCode === 'custom' && !customApi) {
                throw new Error('使用自定义API时必须提供API地址');
            }
            
            if (isIkanbotSource(sourceCode)) {
                return await handleIkanbotDetail(id, sourceCode);
            }

            if (!API_SITES[sourceCode] && sourceCode !== 'custom') {
                throw new Error('无效的API来源');
            }

            // 对于有detail参数的源，都使用特殊处理方式
            if (sourceCode !== 'custom' && API_SITES[sourceCode].detail) {
                return await handleSpecialSourceDetail(id, sourceCode);
            }
            
            // 如果是自定义API，并且传递了detail参数，尝试特殊处理
            // 优先 customDetail
            if (sourceCode === 'custom' && customDetail) {
                return await handleCustomApiSpecialDetail(id, customDetail);
            }
            if (sourceCode === 'custom' && url.searchParams.get('useDetail') === 'true') {
                return await handleCustomApiSpecialDetail(id, customApi);
            }
            
            const detailUrl = customApi
                ? `${customApi}${API_CONFIG.detail.path}${id}`
                : `${API_SITES[sourceCode].api}${API_CONFIG.detail.path}${id}`;
            
            // 添加超时处理
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            try {
                // 添加鉴权参数到代理URL
                const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                    await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(detailUrl)) :
                    PROXY_URL + encodeURIComponent(detailUrl);
                    
                const response = await fetch(proxiedUrl, {
                    headers: API_CONFIG.detail.headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`详情请求失败: ${response.status}`);
                }
                
                // 解析JSON
                const data = await response.json();
                
                // 检查返回的数据是否有效
                if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
                    throw new Error('获取到的详情内容无效');
                }
                
                // 获取第一个匹配的视频详情
                const videoDetail = data.list[0];
                
                // 提取播放地址
                let episodes = [];
                
                if (videoDetail.vod_play_url) {
                    episodes = isXiaomaomiSource(sourceCode)
                        ? selectXiaomaomiEpisodes(videoDetail)
                        : selectPlayableEpisodes(videoDetail);
                }
                
                // 如果没有找到播放地址，尝试使用正则表达式查找m3u8链接
                if (episodes.length === 0 && videoDetail.vod_content) {
                    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
                    episodes = matches.map(link => link.replace(/^\$/, ''));
                }
                
                return JSON.stringify({
                    code: 200,
                    episodes: episodes,
                    detailUrl: detailUrl,
                    videoInfo: {
                        title: videoDetail.vod_name,
                        cover: videoDetail.vod_pic,
                        desc: videoDetail.vod_content,
                        type: videoDetail.type_name,
                        year: videoDetail.vod_year,
                        area: videoDetail.vod_area,
                        director: videoDetail.vod_director,
                        actor: videoDetail.vod_actor,
                        remarks: videoDetail.vod_remarks,
                        // 添加源信息
                        source_name: sourceCode === 'custom' ? '自定义源' : API_SITES[sourceCode].name,
                        source_code: sourceCode
                    }
                });
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
        }

        throw new Error('未知的API路径');
    } catch (error) {
        console.error('API处理错误:', error);
        return JSON.stringify({
            code: 400,
            msg: error.message || '请求处理失败',
            list: [],
            episodes: [],
        });
    }
}

// 处理自定义API的特殊详情页
async function handleCustomApiSpecialDetail(id, customApi) {
    try {
        // 构建详情页URL
        const detailUrl = `${customApi}/index.php/vod/detail/id/${id}.html`;
        
        // 添加超时处理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        // 添加鉴权参数到代理URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(detailUrl)) :
            PROXY_URL + encodeURIComponent(detailUrl);
            
        // 获取详情页HTML
        const response = await fetch(proxiedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`自定义API详情页请求失败: ${response.status}`);
        }
        
        // 获取HTML内容
        const html = await response.text();
        
        // 使用通用模式提取m3u8链接
        const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
        let matches = html.match(generalPattern) || [];
        
        // 处理链接
        matches = matches.map(link => {
            link = link.substring(1, link.length);
            const parenIndex = link.indexOf('(');
            return parenIndex > 0 ? link.substring(0, parenIndex) : link;
        });
        
        // 提取基本信息
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const titleText = titleMatch ? titleMatch[1].trim() : '';
        
        const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);
        const descText = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
        
        return JSON.stringify({
            code: 200,
            episodes: matches,
            detailUrl: detailUrl,
            videoInfo: {
                title: titleText,
                desc: descText,
                source_name: '自定义源',
                source_code: 'custom'
            }
        });
    } catch (error) {
        console.error(`自定义API详情获取失败:`, error);
        throw error;
    }
}

// 通用特殊源详情处理函数
async function handleSpecialSourceDetail(id, sourceCode) {
    try {
        // 构建详情页URL（使用配置中的detail URL而不是api URL）
        const detailUrl = `${API_SITES[sourceCode].detail}/index.php/vod/detail/id/${id}.html`;
        
        // 添加超时处理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        // 添加鉴权参数到代理URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(detailUrl)) :
            PROXY_URL + encodeURIComponent(detailUrl);
            
        // 获取详情页HTML
        const response = await fetch(proxiedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`详情页请求失败: ${response.status}`);
        }
        
        // 获取HTML内容
        const html = await response.text();
        
        // 根据不同源类型使用不同的正则表达式
        let matches = [];
        
        if (sourceCode === 'ffzy') {
            // 非凡影视使用特定的正则表达式
            const ffzyPattern = /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g;
            matches = html.match(ffzyPattern) || [];
        }
        
        // 如果没有找到链接或者是其他源类型，尝试一个更通用的模式
        if (matches.length === 0) {
            const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
            matches = html.match(generalPattern) || [];
        }
        // 去重处理，避免一个播放源多集显示
        matches = [...new Set(matches)];
        // 处理链接
        matches = matches.map(link => {
            link = link.substring(1, link.length);
            const parenIndex = link.indexOf('(');
            return parenIndex > 0 ? link.substring(0, parenIndex) : link;
        });
        
        // 提取可能存在的标题、简介等基本信息
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const titleText = titleMatch ? titleMatch[1].trim() : '';
        
        const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);
        const descText = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
        
        return JSON.stringify({
            code: 200,
            episodes: matches,
            detailUrl: detailUrl,
            videoInfo: {
                title: titleText,
                desc: descText,
                source_name: API_SITES[sourceCode].name,
                source_code: sourceCode
            }
        });
    } catch (error) {
        console.error(`${API_SITES[sourceCode].name}详情获取失败:`, error);
        throw error;
    }
}

// 处理聚合搜索
async function handleAggregatedSearch(searchQuery) {
    // 获取可用的API源列表（排除aggregated和custom）
    const availableSources = Object.keys(API_SITES).filter(key => 
        key !== 'aggregated' && key !== 'custom'
    );
    
    if (availableSources.length === 0) {
        throw new Error('没有可用的API源');
    }
    
    // 创建所有API源的搜索请求
    const searchPromises = availableSources.map(async (source) => {
        try {
            if (isIkanbotSource(source)) {
                return await searchIkanbotByKeyword(searchQuery, source);
            }

            const apiUrl = `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            
            // 使用Promise.race添加超时处理
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`${source}源搜索超时`)), 8000)
            );
            
            // 添加鉴权参数到代理URL
            const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl)) :
                PROXY_URL + encodeURIComponent(apiUrl);
            
            const fetchPromise = fetch(proxiedUrl, {
                headers: API_CONFIG.search.headers
            });
            
            const response = await Promise.race([fetchPromise, timeoutPromise]);
            
            if (!response.ok) {
                throw new Error(`${source}源请求失败: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data || !Array.isArray(data.list)) {
                throw new Error(`${source}源返回的数据格式无效`);
            }
            
            // 为搜索结果添加源信息
            const results = data.list.map(item => ({
                ...item,
                source_name: API_SITES[source].name,
                source_code: source
            }));
            
            return results;
        } catch (error) {
            console.warn(`${source}源搜索失败:`, error);
            return []; // 返回空数组表示该源搜索失败
        }
    });
    
    try {
        // 并行执行所有搜索请求
        const resultsArray = await Promise.all(searchPromises);
        
        // 合并所有结果
        let allResults = [];
        resultsArray.forEach(results => {
            if (Array.isArray(results) && results.length > 0) {
                allResults = allResults.concat(results);
            }
        });
        
        // 如果没有搜索结果，返回空结果
        if (allResults.length === 0) {
            return JSON.stringify({
                code: 200,
                list: [],
                msg: '所有源均无搜索结果'
            });
        }
        
        // 去重（根据vod_id和source_code组合）
        const uniqueResults = [];
        const seen = new Set();
        
        allResults.forEach(item => {
            const key = `${item.source_code}_${item.vod_id}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResults.push(item);
            }
        });
        
        // 按照视频名称和来源排序
        uniqueResults.sort((a, b) => {
            // 首先按照视频名称排序
            const nameCompare = (a.vod_name || '').localeCompare(b.vod_name || '');
            if (nameCompare !== 0) return nameCompare;
            
            // 如果名称相同，则按照来源排序
            return (a.source_name || '').localeCompare(b.source_name || '');
        });
        
        return JSON.stringify({
            code: 200,
            list: uniqueResults,
        });
    } catch (error) {
        console.error('聚合搜索处理错误:', error);
        return JSON.stringify({
            code: 400,
            msg: '聚合搜索处理失败: ' + error.message,
            list: []
        });
    }
}

// 处理多个自定义API源的聚合搜索
async function handleMultipleCustomSearch(searchQuery, customApiUrls) {
    // 解析自定义API列表
    const apiUrls = customApiUrls.split(CUSTOM_API_CONFIG.separator)
        .map(url => url.trim())
        .filter(url => url.length > 0 && /^https?:\/\//.test(url))
        .slice(0, CUSTOM_API_CONFIG.maxSources);
    
    if (apiUrls.length === 0) {
        throw new Error('没有提供有效的自定义API地址');
    }
    
    // 为每个API创建搜索请求
    const searchPromises = apiUrls.map(async (apiUrl, index) => {
        try {
            const fullUrl = `${apiUrl}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            
            // 使用Promise.race添加超时处理
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`自定义API ${index+1} 搜索超时`)), 8000)
            );
            
            // 添加鉴权参数到代理URL
            const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(fullUrl)) :
                PROXY_URL + encodeURIComponent(fullUrl);
            
            const fetchPromise = fetch(proxiedUrl, {
                headers: API_CONFIG.search.headers
            });
            
            const response = await Promise.race([fetchPromise, timeoutPromise]);
            
            if (!response.ok) {
                throw new Error(`自定义API ${index+1} 请求失败: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data || !Array.isArray(data.list)) {
                throw new Error(`自定义API ${index+1} 返回的数据格式无效`);
            }
            
            // 为搜索结果添加源信息
            const results = data.list.map(item => ({
                ...item,
                source_name: `${CUSTOM_API_CONFIG.namePrefix}${index+1}`,
                source_code: 'custom',
                api_url: apiUrl // 保存API URL以便详情获取
            }));
            
            return results;
        } catch (error) {
            console.warn(`自定义API ${index+1} 搜索失败:`, error);
            return []; // 返回空数组表示该源搜索失败
        }
    });
    
    try {
        // 并行执行所有搜索请求
        const resultsArray = await Promise.all(searchPromises);
        
        // 合并所有结果
        let allResults = [];
        resultsArray.forEach(results => {
            if (Array.isArray(results) && results.length > 0) {
                allResults = allResults.concat(results);
            }
        });
        
        // 如果没有搜索结果，返回空结果
        if (allResults.length === 0) {
            return JSON.stringify({
                code: 200,
                list: [],
                msg: '所有自定义API源均无搜索结果'
            });
        }
        
        // 去重（根据vod_id和api_url组合）
        const uniqueResults = [];
        const seen = new Set();
        
        allResults.forEach(item => {
            const key = `${item.api_url || ''}_${item.vod_id}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResults.push(item);
            }
        });
        
        return JSON.stringify({
            code: 200,
            list: uniqueResults,
        });
    } catch (error) {
        console.error('自定义API聚合搜索处理错误:', error);
        return JSON.stringify({
            code: 400,
            msg: '自定义API聚合搜索处理失败: ' + error.message,
            list: []
        });
    }
}

// 拦截API请求
(function() {
    const originalFetch = window.fetch;
    
    window.fetch = async function(input, init) {
        const requestUrl = typeof input === 'string' ? new URL(input, window.location.origin) : input.url;
        
        if (requestUrl.pathname === '/api/search' || requestUrl.pathname === '/api/detail') {
            if (window.isPasswordProtected && window.isPasswordVerified) {
                if (window.isPasswordProtected() && !window.isPasswordVerified()) {
                    return;
                }
            }
            try {
                const data = await handleApiRequest(requestUrl);
                return new Response(data, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            } catch (error) {
                return new Response(JSON.stringify({
                    code: 500,
                    msg: '服务器内部错误',
                }), {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                });
            }
        }
        
        // 非API请求使用原始fetch
        return originalFetch.apply(this, arguments);
    };
})();

async function testSiteAvailability(apiUrl) {
    try {
        // 使用更简单的测试查询
        const response = await fetch('/api/search?wd=test&customApi=' + encodeURIComponent(apiUrl), {
            // 添加超时
            signal: AbortSignal.timeout(5000)
        });
        
        // 检查响应状态
        if (!response.ok) {
            return false;
        }
        
        const data = await response.json();
        
        // 检查API响应的有效性
        return data && data.code !== 400 && Array.isArray(data.list);
    } catch (error) {
        console.error('站点可用性测试失败:', error);
        return false;
    }
}
