// Verify that the decorative video loads and plays only when motion is allowed.
const backdrop = require('./research-backdrop.js');

function eventTarget(target = {}) {
    const handlers = new Map();
    target.addEventListener = (type, handler) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(handler);
    };
    target.removeEventListener = (type, handler) => handlers.get(type)?.delete(handler);
    target.dispatch = (type, event = {}) => {
        for (const handler of [...(handlers.get(type) || [])]) handler({ type, target, ...event });
    };
    return target;
}

function fixture({ search = '', reduced = false, saveData = false, visibilityState = 'visible', play, sources = true } = {}) {
    const media = eventTarget({ matches: reduced });
    const connection = eventTarget({ saveData });
    const documentObject = eventTarget({ visibilityState, readyState: 'complete' });
    const sourceElements = [];
    documentObject.createElement = () => ({ attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } });
    const video = eventTarget({
        dataset: { webm: sources ? 'fleet.webm' : '', mp4: sources ? 'fleet.mp4' : '' },
        ownerDocument: documentObject,
        children: sourceElements,
        poster: 'fleet-poster.jpg',
        paused: true,
        loadCalls: 0,
        playCalls: 0,
        pauseCalls: 0,
        appendChild(source) { sourceElements.push(source); },
        load() { this.loadCalls += 1; },
        play() {
            this.playCalls += 1;
            const result = play ? play(this.playCalls) : Promise.resolve();
            return Promise.resolve(result).then(() => { this.paused = false; });
        },
        pause() { this.pauseCalls += 1; this.paused = true; }
    });
    const toggle = eventTarget({ hidden: false, textContent: '', attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } });
    const hero = { getBoundingClientRect: () => ({ top: 0, right: 200, bottom: 100, left: 0 }) };
    let observer;
    class Observer {
        constructor(callback) { this.callback = callback; observer = this; }
        observe(target) { this.target = target; }
        disconnect() { this.disconnected = true; }
        intersect(isIntersecting, intersectionRatio = isIntersecting ? 1 : 0) {
            this.callback([{ target: this.target, isIntersecting, intersectionRatio }]);
        }
    }
    const windowObject = eventTarget({
        location: { search }, innerWidth: 400, innerHeight: 800,
        matchMedia: () => media,
        IntersectionObserver: Observer
    });
    const navigatorObject = { connection };
    const controller = backdrop.createController({ video, hero, toggle, windowObject, documentObject, navigatorObject });
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
    return { controller, video, toggle, hero, media, connection, documentObject, windowObject, navigatorObject, observer: () => observer, flush };
}

test('loads source elements once only after the visible hero is allowed to animate', async () => {
    const f = fixture();
    f.controller.start();
    expect(f.video.loadCalls).toBe(0);
    expect(f.video.children).toHaveLength(0);
    expect(f.video.playCalls).toBe(0);

    f.observer().intersect(true);
    await f.flush();
    expect(f.video.children.map((source) => source.attrs)).toEqual([
        { src: 'fleet.webm', type: 'video/webm' }, { src: 'fleet.mp4', type: 'video/mp4' }
    ]);
    expect(f.video.loadCalls).toBe(1);
    expect(f.video.playCalls).toBe(1);
    expect(f.controller.getState().playing).toBe(true);

    f.observer().intersect(true);
    f.documentObject.dispatch('visibilitychange');
    await f.flush();
    expect(f.video.loadCalls).toBe(1);
    expect(f.video.playCalls).toBe(1);
    expect(f.video.pauseCalls).toBe(0);
});

test('pauses and resumes on reduced-motion, data-saver, page visibility and hero visibility changes', async () => {
    const f = fixture({ reduced: true });
    f.controller.start();
    f.observer().intersect(true);
    expect(f.video.loadCalls).toBe(0);
    f.media.matches = false;
    f.media.dispatch('change');
    await f.flush();
    expect(f.video.playCalls).toBe(1);

    f.documentObject.visibilityState = 'hidden';
    f.documentObject.dispatch('visibilitychange');
    expect(f.video.pauseCalls).toBe(1);
    f.documentObject.dispatch('visibilitychange');
    expect(f.video.pauseCalls).toBe(1);
    f.documentObject.visibilityState = 'visible';
    f.documentObject.dispatch('visibilitychange');
    await f.flush();
    expect(f.video.playCalls).toBe(2);

    f.connection.saveData = true;
    f.connection.dispatch('change');
    expect(f.video.pauseCalls).toBe(2);
    f.connection.saveData = false;
    f.connection.dispatch('change');
    await f.flush();
    expect(f.video.playCalls).toBe(3);
    f.observer().intersect(false);
    expect(f.video.pauseCalls).toBe(3);
});

test('URL reduced-motion and rejected play preserve the poster without repeated retries', async () => {
    let rejectNext = true;
    const f = fixture({ search: '?reduceMotion=1', play: () => {
        if (rejectNext) { rejectNext = false; return Promise.reject(new Error('autoplay blocked')); }
        return Promise.resolve();
    } });
    f.controller.start();
    f.observer().intersect(true);
    expect(f.video.loadCalls).toBe(0);
    f.windowObject.location.search = '';
    f.media.matches = false;
    f.media.dispatch('change');
    await f.flush();
    expect(f.video.playCalls).toBe(1);
    expect(f.video.poster).toBe('fleet-poster.jpg');
    expect(f.video.paused).toBe(true);

    f.observer().intersect(true);
    await f.flush();
    expect(f.video.playCalls).toBe(1);
    f.observer().intersect(false);
    f.observer().intersect(true);
    await f.flush();
    expect(f.video.playCalls).toBe(2);
    expect(f.controller.getState().playing).toBe(true);
});

test('pure transition effects are empty when playback eligibility has not changed', () => {
    const visible = { ...backdrop.initialState(), heroVisible: true, hasSources: true, sourcesAttached: true,
        playing: true, playAttempted: true };
    expect(backdrop.transition(visible, { heroVisible: true })).toEqual({ state: visible, effects: [] });
});

test('explicit pause prevents initial fetch and can resume; toggle state reflects user intent', async () => {
    const f = fixture();
    f.controller.start();
    expect(f.toggle).toMatchObject({ hidden: false, textContent: 'Pause animation', attrs: { 'aria-pressed': 'false' } });

    f.toggle.dispatch('click', { preventDefault() {} });
    expect(f.toggle).toMatchObject({ textContent: 'Play animation', attrs: { 'aria-pressed': 'true' } });
    f.observer().intersect(true);
    await f.flush();
    expect(f.controller.getState().userPaused).toBe(true);
    expect(f.video.loadCalls).toBe(0);
    expect(f.video.playCalls).toBe(0);

    f.toggle.dispatch('click', { preventDefault() {} });
    await f.flush();
    expect(f.toggle).toMatchObject({ textContent: 'Pause animation', attrs: { 'aria-pressed': 'false' } });
    expect(f.video.loadCalls).toBe(1);
    expect(f.video.playCalls).toBe(1);
});

test('toggle hides while motion is unavailable or source data is absent', () => {
    const f = fixture({ reduced: true });
    f.controller.start();
    expect(f.toggle.hidden).toBe(true);
    f.media.matches = false;
    f.media.dispatch('change');
    expect(f.toggle.hidden).toBe(false);
    f.connection.saveData = true;
    f.connection.dispatch('change');
    expect(f.toggle.hidden).toBe(true);

    const noSource = fixture({ sources: false });
    noSource.controller.start();
    expect(noSource.toggle.hidden).toBe(true);
    noSource.observer().intersect(true);
    expect(noSource.video.loadCalls).toBe(0);
    expect(noSource.video.playCalls).toBe(0);
});
