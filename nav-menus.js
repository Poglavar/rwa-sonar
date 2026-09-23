// Header dropdown menus (<details> in the site header) close on Escape and on a click or tap
// outside them, like any other menu; a <details> on its own only closes from its own summary.
(function () {
    'use strict';

    /** Which open header menus a click should close: every one the click landed outside of. */
    function menusToClose(openMenus, target) {
        return openMenus.filter((menu) => !menu.contains(target));
    }

    if (typeof document !== 'undefined') {
        const openMenus = () => [...document.querySelectorAll('header details[open]')];
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

    if (typeof module !== 'undefined' && module.exports) module.exports = { menusToClose };
})();
