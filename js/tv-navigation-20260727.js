// Versioned filename prevents stale TV-browser and CDN caches.
(function () {
    'use strict';

    const lrud = window.TvLrud;
    if (!lrud || typeof lrud.getNextFocus !== 'function') {
        console.warn('TV navigation is unavailable: LRUD failed to load.');
        return;
    }

    const directionKeys = {
        ArrowLeft: 'ArrowLeft', Left: 'ArrowLeft', 21: 'ArrowLeft', 37: 'ArrowLeft', 214: 'ArrowLeft',
        ArrowRight: 'ArrowRight', Right: 'ArrowRight', 22: 'ArrowRight', 39: 'ArrowRight', 213: 'ArrowRight',
        ArrowUp: 'ArrowUp', Up: 'ArrowUp', 19: 'ArrowUp', 38: 'ArrowUp', 211: 'ArrowUp', 29460: 'ArrowUp',
        ArrowDown: 'ArrowDown', Down: 'ArrowDown', 20: 'ArrowDown', 40: 'ArrowDown', 212: 'ArrowDown', 29461: 'ArrowDown'
    };
    const selectKeys = new Set(['Enter', 'Accept', 'Select', 'OK', '13', '23', '66']);
    const backKeys = new Set(['Escape', 'BrowserBack', 'GoBack', 'Back', '4', '27', '461', '10009']);
    const mediaActions = {
        MediaPlayPause: 'toggle', 10252: 'toggle',
        MediaPlay: 'play', 415: 'play',
        MediaPause: 'pause', 413: 'pause',
        MediaStop: 'stop', 178: 'stop', 413: 'stop',
        MediaTrackPrevious: 'previous', 177: 'previous',
        MediaTrackNext: 'next', 176: 'next',
        MediaRewind: 'seek-backward', 412: 'seek-backward',
        MediaFastForward: 'seek-forward', 417: 'seek-forward'
    };
    const overlaySelectors = [
        '#passwordModal', '#disclaimerModal', '#tagManageModal', '#messageBoxModal',
        '#showImportBoxModal', '#importUrlModal', '#modal', '#historyPanel.show', '#settingsPanel.show'
    ];
    const nativeFocusable = 'a[href], button, input, select, textarea, [tabindex], [data-tv-focusable]';
    let activeScope = document.body;
    let returnFocus = null;
    let refreshQueued = false;

    function eventValues(event) {
        return [event.key, event.code, String(event.keyCode || event.which || '')].filter(Boolean);
    }

    function lookup(map, event) {
        for (const value of eventValues(event)) {
            if (Object.prototype.hasOwnProperty.call(map, value)) return map[value];
        }
        return null;
    }

    function matchesSet(set, event) {
        return eventValues(event).some(value => set.has(value));
    }

    function isVisible(element) {
        if (!element || !element.isConnected || element.hidden) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    }

    function enhance(root) {
        const scope = root && root.querySelectorAll ? root : document;
        const customClickables = [];
        if (scope.nodeType === Node.ELEMENT_NODE && scope.matches('[onclick]')) customClickables.push(scope);
        customClickables.push(...scope.querySelectorAll('[onclick]'));
        customClickables.forEach(element => {
            if (!element.matches('button, a, input, select, textarea')) {
                if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
                if (!element.hasAttribute('role')) element.setAttribute('role', 'button');
                element.setAttribute('data-tv-focusable', '');
            }
        });

        const candidates = [];
        if (scope.nodeType === Node.ELEMENT_NODE && scope.matches(nativeFocusable)) candidates.push(scope);
        candidates.push(...scope.querySelectorAll(nativeFocusable));
        candidates.forEach(element => {
            element.setAttribute('data-tv-focusable', '');
            if (isVisible(element)) element.classList.remove('lrud-ignore');
            else element.classList.add('lrud-ignore');
        });
    }

    function currentScope() {
        for (const selector of overlaySelectors) {
            const element = document.querySelector(selector);
            if (isVisible(element)) return element;
        }
        return document.body;
    }

    function focusElement(element) {
        if (!element || !isVisible(element) || element.disabled) return false;
        try {
            element.focus({ preventScroll: true });
        } catch (error) {
            element.focus();
        }
        try {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        } catch (error) {
            element.scrollIntoView(false);
        }
        return document.activeElement === element;
    }

    function firstFocusable(scope) {
        const preferred = scope.querySelector('[data-tv-initial]:not(.lrud-ignore)');
        if (preferred && isVisible(preferred)) return preferred;
        return Array.from(scope.querySelectorAll(nativeFocusable)).find(element =>
            isVisible(element) && !element.disabled && element.tabIndex >= 0
        );
    }

    function syncScope(shouldFocus) {
        enhance(document);
        const nextScope = currentScope();
        if (nextScope !== activeScope) {
            if (nextScope !== document.body && activeScope === document.body && document.activeElement !== document.body) {
                returnFocus = document.activeElement;
            }
            activeScope = nextScope;
            if (shouldFocus) focusElement(firstFocusable(activeScope));
        }
        return activeScope;
    }

    function activate() {
        document.body.classList.add('tv-navigation-active');
        syncScope(true);
        if (document.activeElement === document.body || !isVisible(document.activeElement)) {
            focusElement(firstFocusable(activeScope));
        }
    }

    function playerAction(action) {
        return !!(window.LibreTVPlayer && window.LibreTVPlayer.handleRemoteAction(action));
    }

    function shouldKeepHorizontalInputKey(target, direction) {
        if (!target || (direction !== 'ArrowLeft' && direction !== 'ArrowRight')) return false;
        if (target.matches('select, input[type="range"]')) return true;
        if (!target.matches('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="password"], input[type="email"], input[type="url"], input[type="tel"]')) {
            return false;
        }

        const start = target.selectionStart;
        const end = target.selectionEnd;
        if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
        if (start !== end) return true;
        return direction === 'ArrowLeft' ? start > 0 : end < target.value.length;
    }

    function closeElement(element) {
        if (!element) return false;
        const close = element.querySelector('#closeTagModal, #closeBoxModal, [data-tv-close], button[onclick*="closeModal"], .close-btn');
        if (close) close.click();
        else element.remove();
        setTimeout(() => {
            activeScope = currentScope();
            if (!focusElement(returnFocus)) focusElement(firstFocusable(activeScope));
            returnFocus = null;
        }, 0);
        return true;
    }

    function handleBack() {
        const dynamicModal = document.querySelector('#tagManageModal, #messageBoxModal, #showImportBoxModal, #importUrlModal');
        if (dynamicModal && isVisible(dynamicModal)) return closeElement(dynamicModal);

        const modal = document.getElementById('modal');
        if (modal && isVisible(modal)) {
            if (typeof window.closeModal === 'function') window.closeModal();
            else modal.classList.add('hidden');
            setTimeout(() => focusElement(returnFocus), 0);
            return true;
        }

        const settings = document.getElementById('settingsPanel');
        if (settings && settings.classList.contains('show')) {
            if (typeof window.toggleSettings === 'function') window.toggleSettings();
            else settings.classList.remove('show');
            setTimeout(() => focusElement(returnFocus), 0);
            return true;
        }
        const history = document.getElementById('historyPanel');
        if (history && history.classList.contains('show')) {
            if (typeof window.toggleHistory === 'function') window.toggleHistory();
            else history.classList.remove('show');
            setTimeout(() => focusElement(returnFocus), 0);
            return true;
        }
        if (window.LibreTVPlayer && window.LibreTVPlayer.isFullscreen()) {
            window.LibreTVPlayer.exitFullscreen();
            return true;
        }
        const results = document.getElementById('resultsArea');
        if (results && !results.classList.contains('hidden') && typeof window.resetToHome === 'function') {
            window.resetToHome();
            setTimeout(() => focusElement(document.getElementById('searchInput')), 0);
            return true;
        }
        if (window.LibreTVPlayer) return playerAction('back');
        if (window.history.length > 1) {
            window.history.back();
            return true;
        }
        return false;
    }

    function onKeyDown(event) {
        const direction = lookup(directionKeys, event);
        const mediaAction = lookup(mediaActions, event);
        const isSelect = matchesSet(selectKeys, event);
        const isBack = matchesSet(backKeys, event) && !direction;
        if (!direction && !mediaAction && !isSelect && !isBack) return;

        activate();
        const target = document.activeElement;
        const input = target && target.matches('input, textarea, select');

        if (mediaAction) {
            if (playerAction(mediaAction)) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
            return;
        }
        if (isBack) {
            if (handleBack()) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
            return;
        }
        if (isSelect) {
            if (input) return;
            const handled = target && target.matches('[data-tv-player-surface]') ? playerAction('toggle') : false;
            if (!handled && target && target !== document.body) target.click();
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        // Text editing keeps Left/Right until the caret reaches an edge. A
        // further press then exits the field, which is essential on remotes.
        if (input && shouldKeepHorizontalInputKey(target, direction)) return;

        if (target && target.matches('[data-tv-player-surface]')) {
            const action = {
                ArrowLeft: 'seek-backward', ArrowRight: 'seek-forward',
                ArrowUp: 'volume-up', ArrowDown: 'volume-down'
            }[direction];
            if (playerAction(action)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
        }

        const scope = syncScope(false);
        const next = lrud.getNextFocus(target, direction, scope);
        if (next && focusElement(next)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    function queueRefresh() {
        if (refreshQueued) return;
        refreshQueued = true;
        requestAnimationFrame(() => {
            refreshQueued = false;
            syncScope(document.body.classList.contains('tv-navigation-active'));
        });
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerover', event => {
        if (document.body.classList.contains('tv-navigation-active')) {
            const target = event.target.closest(nativeFocusable);
            if (target && isVisible(target)) target.focus({ preventScroll: true });
        }
    }, true);
    new MutationObserver(queueRefresh).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'aria-hidden']
    });

    document.addEventListener('DOMContentLoaded', () => {
        enhance(document);
        activeScope = currentScope();
    });
})();
