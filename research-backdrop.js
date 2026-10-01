// Purpose: keep the decorative research-fleet video unloaded until its hero is visible and motion is allowed.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.__rwaResearchBackdrop = api;
        api.mount(root.document, root, root.navigator);
    }
})(typeof globalThis === 'object' ? globalThis : this, function () {
    function wantsMotion(signals) {
        return Boolean(signals.heroVisible && signals.pageVisible && signals.hasSources
            && !signals.reducedMotion && !signals.saveData && !signals.userPaused);
    }

    // Pure transition function: the adapter executes these effects and reports playback events back.
    function transition(previous, changes = {}) {
        const state = { ...previous, ...changes };
        const playAllowed = wantsMotion(state);
        const effects = [];
        if (!playAllowed) {
            if (state.playing || state.playPending) effects.push('pause');
            state.playing = false;
            state.playPending = false;
            state.playAttempted = false;
        } else {
            if (!state.sourcesAttached) effects.push('attach-sources');
            if (!state.playing && !state.playPending && !state.playAttempted) {
                effects.push('play');
                state.playPending = true;
                state.playAttempted = true;
            }
            if (effects.includes('attach-sources')) state.sourcesAttached = true;
        }
        return { state, effects };
    }

    function initialState(signals = {}) {
        return {
            heroVisible: false,
            pageVisible: true,
            reducedMotion: false,
            saveData: false,
            hasSources: false,
            sourcesAttached: false,
            playing: false,
            playPending: false,
            playAttempted: false,
            userPaused: false,
            ...signals
        };
    }

    function queryRequestsReducedMotion(search) {
        if (typeof search !== 'string' || !search) return false;
        try { return new URLSearchParams(search).has('reduceMotion'); }
        catch { return /(?:^|[?&])reduceMotion(?:=1|=true)?(?:&|$)/.test(search); }
    }

    function dataValue(video, name) {
        if (video?.dataset && typeof video.dataset[name] === 'string') return video.dataset[name].trim();
        const value = video?.getAttribute?.(`data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
        return typeof value === 'string' ? value.trim() : '';
    }

    function attachSources(video) {
        const webm = dataValue(video, 'webm');
        const mp4 = dataValue(video, 'mp4');
        for (const [src, type] of [[webm, 'video/webm'], [mp4, 'video/mp4']]) {
            if (!src) continue;
            const source = video.ownerDocument.createElement('source');
            source.setAttribute('src', src);
            source.setAttribute('type', type);
            video.appendChild(source);
        }
        video.load();
    }

    function inViewport(element, view) {
        const rect = element?.getBoundingClientRect?.();
        if (!rect) return false;
        const width = view?.innerWidth ?? 0;
        const height = view?.innerHeight ?? 0;
        return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
    }

    function createController({ video, hero, toggle = null, windowObject, documentObject, navigatorObject, IntersectionObserverCtor } = {}) {
        if (!video || !hero || !windowObject || !documentObject) throw new Error('Research backdrop needs video, hero, window and document');
        const media = typeof windowObject.matchMedia === 'function' ? windowObject.matchMedia('(prefers-reduced-motion: reduce)') : null;
        const connection = navigatorObject?.connection || navigatorObject?.mozConnection || navigatorObject?.webkitConnection || null;
        const hasSources = Boolean(dataValue(video, 'webm') || dataValue(video, 'mp4'));
        let state = initialState({
            pageVisible: documentObject.visibilityState !== 'hidden',
            reducedMotion: queryRequestsReducedMotion(windowObject.location?.search) || Boolean(media?.matches),
            saveData: Boolean(connection?.saveData),
            hasSources
        });
        let observer = null;
        let started = false;
        let disposed = false;
        const listeners = [];
        const listen = (target, type, handler) => {
            if (!target?.addEventListener) return;
            target.addEventListener(type, handler);
            listeners.push(() => target.removeEventListener?.(type, handler));
        };
        const onMediaChange = (event) => update({ reducedMotion: queryRequestsReducedMotion(windowObject.location?.search) || Boolean(event.matches) });
        const onConnectionChange = () => update({ saveData: Boolean(connection?.saveData) });
        const onVisibilityChange = () => update({ pageVisible: documentObject.visibilityState !== 'hidden' });
        const onFallbackViewport = () => update({ heroVisible: inViewport(hero, windowObject) });
        const onPlaying = () => update({ playing: true, playPending: false });
        const onPause = () => update({ playing: false, playPending: false });
        const onToggle = (event) => {
            event?.preventDefault?.();
            update({ userPaused: !state.userPaused });
        };

        function syncToggle() {
            if (!toggle) return;
            toggle.hidden = !state.hasSources || state.reducedMotion || state.saveData;
            toggle.textContent = state.userPaused ? 'Play animation' : 'Pause animation';
            toggle.setAttribute?.('aria-pressed', String(state.userPaused));
        }

        function execute(effects) {
            for (const effect of effects) {
                if (effect === 'attach-sources') {
                    attachSources(video);
                } else if (effect === 'pause') {
                    video.pause();
                } else if (effect === 'play') {
                    try {
                        const result = video.play();
                        if (result && typeof result.then === 'function') {
                            result.then(() => update({ playing: true, playPending: false }), () => update({ playPending: false }));
                        } else update({ playing: true, playPending: false });
                    } catch {
                        update({ playPending: false });
                    }
                }
            }
        }

        function update(changes) {
            if (disposed) return;
            const result = transition(state, changes);
            state = result.state;
            syncToggle();
            execute(result.effects);
        }

        function start() {
            if (started || disposed) return controller;
            started = true;
            listen(documentObject, 'visibilitychange', onVisibilityChange);
            listen(media, 'change', onMediaChange);
            listen(connection, 'change', onConnectionChange);
            listen(video, 'playing', onPlaying);
            listen(video, 'pause', onPause);
            listen(toggle, 'click', onToggle);
            syncToggle();
            const Observer = IntersectionObserverCtor || windowObject.IntersectionObserver;
            if (typeof Observer === 'function') {
                observer = new Observer((entries) => {
                    const entry = entries.find((row) => row.target === hero);
                    if (entry) update({ heroVisible: Boolean(entry.isIntersecting && entry.intersectionRatio > 0) });
                }, { threshold: 0.01 });
                observer.observe(hero);
            } else {
                listen(windowObject, 'scroll', onFallbackViewport);
                listen(windowObject, 'resize', onFallbackViewport);
                onFallbackViewport();
            }
            return controller;
        }

        function dispose() {
            if (disposed) return;
            if (state.playing || state.playPending) execute(['pause']);
            state = { ...state, playing: false, playPending: false, playAttempted: false };
            disposed = true;
            observer?.disconnect?.();
            for (const remove of listeners.splice(0)) remove();
        }

        const controller = { start, dispose, getState: () => ({ ...state }) };
        return controller;
    }

    function mount(documentObject, windowObject, navigatorObject) {
        if (!documentObject || !windowObject) return null;
        const boot = () => {
            const video = documentObject.getElementById('researchBackdropVideo');
            if (!video) return null;
            if (video.__researchBackdropController) return video.__researchBackdropController;
            const hero = video.closest?.('[data-research-hero]') || video.closest?.('.mission-intro')
                || video.closest?.('section') || video.parentElement;
            if (!hero) return null;
            const toggle = documentObject.getElementById('researchBackdropToggle');
            const controller = createController({ video, hero, toggle, windowObject, documentObject, navigatorObject }).start();
            video.__researchBackdropController = controller;
            return controller;
        };
        if (documentObject.readyState === 'loading') {
            documentObject.addEventListener('DOMContentLoaded', boot, { once: true });
            return null;
        }
        return boot();
    }

    return { initialState, wantsMotion, transition, queryRequestsReducedMotion, createController, mount };
});
