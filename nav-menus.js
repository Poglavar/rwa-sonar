// Header dropdown menus (<details> in the site header) close on Escape and on a click or tap
// outside them, like any other menu; a <details> on its own only closes from its own summary.
(function () {
    'use strict';

    /**
     * The open menus: only the SITE header's (.app-header). A bare `header details` also caught the
     * collapsible blocks in a token card's own <header class="card-head">, so one click on any of
     * them closed all the others (30 Sep).
     */
    const MENU_SELECTOR = '.app-header details[open]';

    /** Which open header menus a click should close: every one the click landed outside of. */
    function menusToClose(openMenus, target) {
        return openMenus.filter((menu) => !menu.contains(target));
    }

    if (typeof document !== 'undefined') {
        const openMenus = () => [...document.querySelectorAll(MENU_SELECTOR)];
        document.addEventListener('click', (event) => {
            for (const menu of menusToClose(openMenus(), event.target)) menu.open = false;
        });
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            for (const menu of openMenus()) {
                menu.open = false;
                menu.querySelector('summary')?.focus();
            }
        });
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { MENU_SELECTOR, menusToClose };
})();
