(function () {
    'use strict';

    const REMOTE_MODE_KEY = 'libretvRemoteModeAt';
    const REMOTE_MODE_TTL = 30 * 24 * 60 * 60 * 1000;
    const LOCAL_FALLBACK = 'image/nomedia.png';
    const TV_USER_AGENT = /SmartTV|SMART-TV|Tizen|Web0S|WebOS|NetCast|HbbTV|AFTB|AFTM|AFTS|AFTT|BRAVIA|CrKey|MiTV|MIBOX|DangBei|Hisense|Skyworth|Konka|Viera|TV Safari|Android(?!.*Mobile)/i;
    const LEGACY_IMAGE_FORMAT = /\.(?:webp|avif|heic)(?:[?#]|$)/i;

    function markRemoteMode() {
        const wasAlreadyActive = hasRecentRemoteUse();
        try {
            localStorage.setItem(REMOTE_MODE_KEY, String(Date.now()));
        } catch (error) {
            // Storage can be unavailable in private TV-browser sessions.
        }
        if (!wasAlreadyActive) setTimeout(() => loadImages(document), 0);
    }

    function hasRecentRemoteUse() {
        try {
            const timestamp = Number(localStorage.getItem(REMOTE_MODE_KEY) || 0);
            return timestamp > 0 && Date.now() - timestamp < REMOTE_MODE_TTL;
        } catch (error) {
            return false;
        }
    }

    function shouldPreferProxy() {
        return hasRecentRemoteUse() || TV_USER_AGENT.test(navigator.userAgent || '');
    }

    function isRemoteUrl(value) {
        return /^https?:\/\//i.test(value || '');
    }

    async function buildProxyUrl(targetUrl) {
        if (!isRemoteUrl(targetUrl)) return targetUrl;
        const proxyPath = (window.PROXY_URL || '/proxy/') + encodeURIComponent(targetUrl);
        if (!window.ProxyAuth || typeof window.ProxyAuth.addAuthToProxyUrl !== 'function') {
            return proxyPath;
        }
        return window.ProxyAuth.addAuthToProxyUrl(proxyPath);
    }

    function originalImageUrl(image) {
        return image && (image.getAttribute('data-media-src') || image.currentSrc || image.src || '');
    }

    function isImageConnected(image) {
        if (!image) return false;
        if (typeof image.isConnected === 'boolean') return image.isConnected;
        return !!(document.documentElement && document.documentElement.contains(image));
    }

    function jpegConversionUrl(originalUrl) {
        return 'https://images.weserv.nl/?url=' + encodeURIComponent(originalUrl)
            + '&output=jpg&w=480&q=82';
    }

    function useLocalFallback(image) {
        if (!image) return;
        image.onerror = null;
        image.removeAttribute('data-media-loading');
        image.setAttribute('data-media-stage', 'fallback');
        image.classList.add('object-contain');
        image.src = LOCAL_FALLBACK;
    }

    async function loadStage(image, stage) {
        if (!isImageConnected(image)) return;
        const originalUrl = originalImageUrl(image);
        if (!isRemoteUrl(originalUrl)) {
            useLocalFallback(image);
            return;
        }

        image.setAttribute('data-media-stage', stage);
        image.setAttribute('data-media-loading', 'true');

        try {
            let nextUrl = originalUrl;
            if (stage === 'proxy') nextUrl = await buildProxyUrl(originalUrl);
            if (stage === 'jpeg') nextUrl = await buildProxyUrl(jpegConversionUrl(originalUrl));
            if ((stage === 'proxy' || stage === 'jpeg') && !/[?&]auth=/.test(nextUrl)) {
                throw new Error('Proxy authentication is unavailable');
            }
            if (!isImageConnected(image) || image.getAttribute('data-media-stage') !== stage) return;
            image.src = nextUrl;
        } catch (error) {
            if (stage === 'proxy') await loadStage(image, 'jpeg');
            else useLocalFallback(image);
        } finally {
            if (image && image.getAttribute('data-media-stage') === stage) {
                image.removeAttribute('data-media-loading');
            }
        }
    }

    async function loadImage(image) {
        const originalUrl = originalImageUrl(image);
        if (!isRemoteUrl(originalUrl)) return;
        if (shouldPreferProxy()) {
            await loadStage(image, LEGACY_IMAGE_FORMAT.test(originalUrl) ? 'jpeg' : 'proxy');
        } else {
            image.setAttribute('data-media-stage', 'direct');
            image.src = originalUrl;
        }
    }

    async function handleImageError(image) {
        if (!image || image.getAttribute('data-media-loading') === 'true') return;
        const originalUrl = originalImageUrl(image);
        const stage = image.getAttribute('data-media-stage') || 'direct';

        if (stage === 'direct') {
            await loadStage(image, LEGACY_IMAGE_FORMAT.test(originalUrl) ? 'jpeg' : 'proxy');
        } else if (stage === 'proxy') {
            await loadStage(image, 'jpeg');
        } else {
            useLocalFallback(image);
        }
    }

    function loadImages(root) {
        const scope = root && root.querySelectorAll ? root : document;
        const images = scope.querySelectorAll('img[data-media-src]');
        for (let index = 0; index < images.length; index++) {
            loadImage(images[index]);
        }
    }

    window.MediaCompat = {
        markRemoteMode,
        shouldPreferProxy,
        buildProxyUrl,
        loadImage,
        loadImages,
        handleImageError
    };
})();
