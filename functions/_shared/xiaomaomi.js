const SOURCE_HOSTS = ['qq.com', 'iqiyi.com', 'youku.com', 'bilibili.com', 'mgtv.com'];
const PARSER_API = 'https://cache.0567890.xyz:4433/Api';
const PARSER_ORIGIN = 'https://jx.xmflv.com';
const SIGN_IV = 'fUU9eRmkYzsgbkEK';

export class XiaomaomiResolveError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.name = 'XiaomaomiResolveError';
        this.status = status;
    }
}

function rotateLeft(value, shift) {
    return (value << shift) | (value >>> (32 - shift));
}

export function md5Hex(input) {
    const source = new TextEncoder().encode(String(input));
    const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(source);
    bytes[source.length] = 0x80;

    const bitLength = source.length * 8;
    const view = new DataView(bytes.buffer);
    view.setUint32(paddedLength - 8, bitLength >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

    const shifts = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const constants = Array.from({ length: 64 }, (_, index) =>
        Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let offset = 0; offset < bytes.length; offset += 64) {
        const words = Array.from({ length: 16 }, (_, index) =>
            view.getUint32(offset + index * 4, true));
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;

        for (let index = 0; index < 64; index += 1) {
            let mixed;
            let wordIndex;
            if (index < 16) {
                mixed = (b & c) | (~b & d);
                wordIndex = index;
            } else if (index < 32) {
                mixed = (d & b) | (~d & c);
                wordIndex = (5 * index + 1) % 16;
            } else if (index < 48) {
                mixed = b ^ c ^ d;
                wordIndex = (3 * index + 5) % 16;
            } else {
                mixed = c ^ (b | ~d);
                wordIndex = (7 * index) % 16;
            }

            const previousD = d;
            d = c;
            c = b;
            const sum = (a + mixed + constants[index] + words[wordIndex]) >>> 0;
            b = (b + rotateLeft(sum, shifts[index])) >>> 0;
            a = previousD;
        }

        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    return [a0, b0, c0, d0].map(word => {
        let hex = '';
        for (let index = 0; index < 4; index += 1) {
            hex += ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return hex;
    }).join('');
}

function isAllowedHost(hostname) {
    const normalized = hostname.toLowerCase();
    return SOURCE_HOSTS.some(host => normalized === host || normalized.endsWith(`.${host}`));
}

export function validateXiaomaomiSourceUrl(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
        throw new XiaomaomiResolveError('小猫咪播放页地址格式无效', 400);
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new XiaomaomiResolveError('小猫咪播放页地址格式无效', 400);
    }

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || (parsed.port && parsed.port !== '443') || !isAllowedHost(parsed.hostname)) {
        throw new XiaomaomiResolveError('小猫咪播放页域名不在允许列表中', 400);
    }
    parsed.hash = '';
    return parsed.toString();
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function createSignature(timestamp, encodedUrl) {
    const encoder = new TextEncoder();
    const key = md5Hex(timestamp + encodedUrl);
    const aesKey = md5Hex(key);
    const cryptoKey = await crypto.subtle.importKey(
        'raw', encoder.encode(aesKey), { name: 'AES-CBC' }, false, ['encrypt']);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: encoder.encode(SIGN_IV) }, cryptoKey, encoder.encode(key)));

    // WebCrypto always adds PKCS#7 padding. The parser protocol encrypts the
    // two complete key blocks with no padding, which are the first 32 bytes.
    return { key, sign: bytesToBase64(encrypted.subarray(0, 32)) };
}

async function decryptParserResponse(payload) {
    if (typeof payload.key !== 'string' || payload.key.length !== 16
        || typeof payload.iv !== 'string' || payload.iv.length !== 16
        || typeof payload.data !== 'string') {
        throw new XiaomaomiResolveError('小猫咪解析器返回了无效数据');
    }

    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        'raw', encoder.encode(payload.key), { name: 'AES-CBC' }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: encoder.encode(payload.iv) },
        cryptoKey,
        base64ToBytes(payload.data));
    const text = new TextDecoder().decode(decrypted);
    const jsonStart = text.indexOf('{');
    if (jsonStart < 0) throw new XiaomaomiResolveError('小猫咪解析器没有返回媒体信息');

    try {
        return JSON.parse(text.substring(jsonStart));
    } catch {
        throw new XiaomaomiResolveError('小猫咪媒体信息解析失败');
    }
}

function validateMediaUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new XiaomaomiResolveError('小猫咪解析器没有返回有效媒体地址');
    }

    if (parsed.protocol !== 'https:' || parsed.hostname !== 'cache.0567890.xyz'
        || parsed.port !== '4433' || !parsed.pathname.startsWith('/Cache/')
        || !parsed.pathname.toLowerCase().endsWith('.m3u8') || !parsed.searchParams.get('vkey')) {
        throw new XiaomaomiResolveError('小猫咪解析器返回了未识别的媒体地址');
    }
    return parsed.toString();
}

export async function resolveXiaomaomiSource(sourceUrl, options = {}) {
    const normalizedUrl = validateXiaomaomiSourceUrl(sourceUrl);
    const encodedUrl = encodeURIComponent(normalizedUrl);
    const timestamp = Date.now().toString();
    const { key, sign } = await createSignature(timestamp, encodedUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 20000);

    let response;
    try {
        response = await (options.fetch || fetch)(PARSER_API, {
            method: 'POST',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Origin': PARSER_ORIGIN,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
            },
            body: new URLSearchParams({ tm: timestamp, url: encodedUrl, key, sign }),
            signal: controller.signal
        });
    } catch (error) {
        const message = error && error.name === 'AbortError'
            ? '小猫咪解析请求超时'
            : '小猫咪解析服务连接失败';
        throw new XiaomaomiResolveError(message, 502);
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        throw new XiaomaomiResolveError(`小猫咪解析服务响应异常 (${response.status})`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new XiaomaomiResolveError('小猫咪解析服务返回了无效响应');
    }
    if (!payload || payload.code !== 200) {
        throw new XiaomaomiResolveError(payload && (payload.msg || payload.message)
            || '小猫咪解析服务暂时繁忙', 502);
    }

    const media = await decryptParserResponse(payload);
    return {
        url: validateMediaUrl(media.url),
        name: typeof media.name === 'string' ? media.name : '',
        type: 'hls'
    };
}
