import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { resolveXiaomaomiSource, XiaomaomiResolveError } from './functions/_shared/xiaomaomi.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  password: process.env.PASSWORD || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function sha256Hash(input) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    hash.update(input);
    resolve(hash.digest('hex'));
  });
}

async function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (password !== '') {
    const sha256 = await sha256Hash(password);
    content = content.replace('{{PASSWORD}}', sha256);
  } else {
    content = content.replace('{{PASSWORD}}', '');
  }
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }
    
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    
    // 从环境变量获取阻止的 IP 前缀
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;
    
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

// 验证代理请求的鉴权
function validateProxyAuth(req) {
  const authHash = req.query.auth;
  const timestamp = req.query.t;
  
  // 获取服务器端密码哈希
  const serverPassword = config.password;
  if (!serverPassword) {
    console.error('服务器未设置 PASSWORD 环境变量，代理访问被拒绝');
    return false;
  }
  
  // 使用 crypto 模块计算 SHA-256 哈希
  const serverPasswordHash = crypto.createHash('sha256').update(serverPassword).digest('hex');
  
  if (!authHash || authHash !== serverPasswordHash) {
    console.warn('代理请求鉴权失败：密码哈希不匹配');
    console.warn(`期望: ${serverPasswordHash}, 收到: ${authHash}`);
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

const xiaomaomiResolveCache = new Map();

app.post('/api/xiaomaomi-resolve', express.json({ limit: '4kb' }), async (req, res) => {
  if (!validateProxyAuth(req)) {
    return res.status(401).json({ code: 401, msg: '解析请求鉴权失败' });
  }

  const sourceUrl = req.body && req.body.url;
  const cached = xiaomaomiResolveCache.get(sourceUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ code: 200, ...cached.media });
  }

  try {
    const media = await resolveXiaomaomiSource(sourceUrl);
    xiaomaomiResolveCache.set(sourceUrl, {
      media,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    return res.json({ code: 200, ...media });
  } catch (error) {
    const status = error instanceof XiaomaomiResolveError ? error.status : 502;
    return res.status(status).json({ code: status, msg: error.message || '小猫咪解析失败' });
  }
});

function isM3u8Response(targetUrl, headers) {
  const contentType = String(headers && headers['content-type'] || '').toLowerCase();
  if (contentType.includes('mpegurl') || contentType.includes('m3u8')) return true;

  try {
    return /\.m3u8?$/i.test(new URL(targetUrl).pathname);
  } catch {
    return /\.m3u8?(?:[?#]|$)/i.test(targetUrl || '');
  }
}

function nestedProxyUrl(targetUrl, req) {
  const query = new URLSearchParams();
  const rawValue = req.query && req.query.auth;
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  if (typeof value === 'string' && value) query.set('auth', value);

  const proxyPath = `/proxy/${encodeURIComponent(targetUrl)}`;
  const queryString = query.toString();
  return queryString ? `${proxyPath}?${queryString}` : proxyPath;
}

function resolvePlaylistUri(playlistUrl, uri) {
  if (!uri || (/^[a-z][a-z\d+.-]*:/i.test(uri) && !/^https?:/i.test(uri))) {
    return '';
  }

  try {
    return new URL(uri, playlistUrl).href;
  } catch {
    return '';
  }
}

function rewriteM3u8(content, playlistUrl, req) {
  const rewriteUri = (uri) => {
    const absoluteUrl = resolvePlaylistUri(playlistUrl, uri);
    return absoluteUrl ? nestedProxyUrl(absoluteUrl, req) : uri;
  };

  return content.split(/\r?\n/).map((originalLine) => {
    const line = originalLine.trim();
    if (!line) return originalLine;

    if (!line.startsWith('#')) return rewriteUri(line);

    return originalLine.replace(
      /(\bURI\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^,\s]+))/gi,
      (match, prefix, doubleQuoted, singleQuoted, unquoted) => {
        const uri = doubleQuoted ?? singleQuoted ?? unquoted;
        const rewritten = rewriteUri(uri);
        if (rewritten === uri) return match;
        if (doubleQuoted !== undefined) return `${prefix}"${rewritten}"`;
        if (singleQuoted !== undefined) return `${prefix}'${rewritten}'`;
        return `${prefix}${rewritten}`;
      }
    );
  }).join('\n');
}

async function readTextStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    // 验证鉴权
    if (!validateProxyAuth(req)) {
      return res.status(401).json({
        success: false,
        error: '代理访问未授权：请检查密码配置或鉴权参数'
      });
    }

    const encodedUrl = req.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    // 安全验证
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的 URL');
    }

    log(`代理请求: ${targetUrl}`);

    // 添加请求超时和重试逻辑
    const maxRetries = config.maxRetries;
    let retries = 0;
    
    const makeRequest = async () => {
      try {
        return await axios({
          method: 'get',
          url: targetUrl,
          responseType: 'stream',
          timeout: config.timeout,
          headers: {
            'User-Agent': config.userAgent,
            'Accept': req.headers.accept || '*/*',
            'Referer': `${new URL(targetUrl).origin}/`,
            ...(req.headers.range ? { Range: req.headers.range } : {}),
            ...(req.headers['if-range'] ? { 'If-Range': req.headers['if-range'] } : {})
          }
        });
      } catch (error) {
        if (retries < maxRetries) {
          retries++;
          log(`重试请求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();

    // 转发响应头（过滤敏感头）
    const headers = { ...response.headers };
    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS || 
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');
    
    sensitiveHeaders.forEach(header => delete headers[header.trim().toLowerCase()]);

    if (isM3u8Response(targetUrl, response.headers)) {
      const playlistUrl = response.request?.res?.responseUrl || targetUrl;
      const content = await readTextStream(response.data);
      delete headers['content-length'];
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      headers['content-type'] = 'application/vnd.apple.mpegurl; charset=utf-8';
      headers['cache-control'] = 'no-store';
      res.status(response.status).set(headers).send(rewriteM3u8(content, playlistUrl, req));
      return;
    }

    res.status(response.status).set(headers);
    response.data.pipe(res);
  } catch (error) {
    console.error('代理请求错误:', error.message);
    if (error.response) {
      res.status(error.response.status || 500);
      error.response.data.pipe(res);
    } else {
      res.status(500).send(`请求失败: ${error.message}`);
    }
  }
});

app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// 启动服务器
app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.password !== '') {
    console.log('用户登录密码已设置');
  } else {
    console.log('警告: 未设置 PASSWORD 环境变量，用户将被要求设置密码');
  }
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config, password: config.password ? '******' : '' });
  }
});
