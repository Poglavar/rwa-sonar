// Site-wide colour theme: Auto (follows the device), Light or Dark, remembered per browser. Loaded
// synchronously in <head> before any stylesheet, so <html data-theme> is set before first paint; the
// theme switch in the site header (stocks/lib/site-nav.js) cycles Auto → Light → Dark on click.
(function () {
    'use strict';

    const STORAGE_KEY = 'rwa-theme';
    const MODES = ['auto', 'light', 'dark'];
    const NAMES = { auto: 'Auto', light: 'Light', dark: 'Dark' };

    /** A stored choice as a mode; nothing stored, or anything unrecognised, is Auto. */
    function normalizeMode(value) {
        return MODES.includes(value) ? value : 'auto';
    }

    /** The theme to draw: the chosen one, or in Auto the device's. */
    function resolveTheme(mode, systemDark) {
        const chosen = normalizeMode(mode);
        if (chosen !== 'auto') return chosen;
        return systemDark === true ? 'dark' : 'light';
    }

    /** The mode a click moves to: Auto → Light → Dark → Auto. */
    function nextMode(mode) {
        return MODES[(MODES.indexOf(normalizeMode(mode)) + 1) % MODES.length];
    }

    /** The switch's accessible name and tooltip for a mode. */
    function modeLabel(mode) {
        const chosen = normalizeMode(mode);
        return chosen === 'auto' ? 'Theme: Auto (follows your device)' : `Theme: ${NAMES[chosen]}`;
    }

    if (typeof document !== 'undefined') {
        const root = document.documentElement;
        const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

        // Storage can throw (blocked site data, some private windows): the page then keeps the
        // choice for this visit only and still works.
        const readStored = () => {
            try {
                return window.localStorage.getItem(STORAGE_KEY);
            } catch (err) {
                return null;
            }
        };
        const writeStored = (value) => {
            try {
                if (value === 'auto') window.localStorage.removeItem(STORAGE_KEY);
                else window.localStorage.setItem(STORAGE_KEY, value);
            } catch (err) {
                // Not remembered; the switch still changes this page.
            }
        };

        let mode = normalizeMode(readStored());

        const labelSwitches = () => {
            const label = modeLabel(mode);
            for (const button of document.querySelectorAll('.theme-switch')) {
                button.setAttribute('aria-label', label);
                button.title = label;
                const state = button.querySelector('.theme-switch-state');
                if (state !== null) state.textContent = NAMES[mode];
            }
        };

        const apply = () => {
            const theme = resolveTheme(mode, media !== null && media.matches);
            // app-shell.css sets color-scheme from data-theme, so a page with its own fixed scheme
            // (the pitch deck) keeps it.
            root.setAttribute('data-theme', theme);
            root.setAttribute('data-theme-mode', mode);
            labelSwitches();
        };

        apply();

        if (media !== null) {
            const follow = () => { if (mode === 'auto') apply(); };
            if (typeof media.addEventListener === 'function') media.addEventListener('change', follow);
            else if (typeof media.addListener === 'function') media.addListener(follow);
        }

        document.addEventListener('click', (event) => {
            const button = event.target instanceof Element ? event.target.closest('.theme-switch') : null;
            if (button === null) return;
            mode = nextMode(mode);
            writeStored(mode);
            apply();
        });

        // The choice changed elsewhere: in another tab, or on a later page before Back restored
        // this one from the back/forward cache.
        const reread = () => {
            mode = normalizeMode(readStored());
            apply();
        };
        window.addEventListener('storage', (event) => {
            if (event.key === STORAGE_KEY || event.key === null) reread();
        });
        window.addEventListener('pageshow', (event) => {
            if (event.persisted) reread();
        });

        // The header is parsed after this script ran: name its switch once it exists.
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', labelSwitches);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { STORAGE_KEY, MODES, NAMES, normalizeMode, resolveTheme, nextMode, modeLabel };
    }
})();
