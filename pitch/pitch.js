(function () {
    const slides = Array.from(document.querySelectorAll('.slide'));
    const label = document.getElementById('slideLabel');
    const progress = document.getElementById('progressBar');
    const previous = document.getElementById('previousSlide');
    const next = document.getElementById('nextSlide');
    const overviewButton = document.getElementById('overviewButton');
    const overview = document.getElementById('deckOverview');
    let activeIndex = Math.max(0, slides.findIndex((slide) => `#${slide.id}` === location.hash));

    function update(index, replaceHash) {
        activeIndex = Math.max(0, Math.min(slides.length - 1, index));
        label.textContent = `${String(activeIndex + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
        progress.style.width = `${((activeIndex + 1) / slides.length) * 100}%`;
        previous.disabled = activeIndex === 0;
        next.disabled = activeIndex === slides.length - 1;
        document.title = `${slides[activeIndex].dataset.title} — RWA Sonar pitch`;
        if (replaceHash && history.replaceState) history.replaceState(null, '', `#${slides[activeIndex].id}`);
    }

    function go(index) {
        const target = slides[Math.max(0, Math.min(slides.length - 1, index))];
        target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        target.focus({ preventScroll: true });
        closeOverview();
    }

    function closeOverview() {
        overview.hidden = true;
        overviewButton.setAttribute('aria-expanded', 'false');
    }

    function toggleOverview() {
        overview.hidden = !overview.hidden;
        overviewButton.setAttribute('aria-expanded', String(!overview.hidden));
        if (!overview.hidden) overview.querySelector('a')?.focus();
    }

    const observer = new IntersectionObserver((entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        update(slides.indexOf(visible.target), true);
    }, { threshold: [.45, .7] });
    slides.forEach((slide) => observer.observe(slide));

    previous.addEventListener('click', () => go(activeIndex - 1));
    next.addEventListener('click', () => go(activeIndex + 1));
    overviewButton.addEventListener('click', toggleOverview);
    overview.addEventListener('click', (event) => {
        if (event.target.closest('a')) closeOverview();
    });

    document.addEventListener('keydown', (event) => {
        if (event.defaultPrevented || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
            event.preventDefault(); go(activeIndex + 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
            event.preventDefault(); go(activeIndex - 1);
        } else if (event.key.toLowerCase() === 'o') {
            event.preventDefault(); toggleOverview();
        } else if (event.key === 'Escape') {
            closeOverview();
        } else if (event.key === 'Home') {
            event.preventDefault(); go(0);
        } else if (event.key === 'End') {
            event.preventDefault(); go(slides.length - 1);
        }
    });

    function resolveApiOrigin() {
        const configured = new URLSearchParams(location.search).get('api');
        if (!configured) return '';
        try {
            const parsed = new URL(configured);
            if (!/^https?:$/.test(parsed.protocol)) return '';
            return parsed.origin;
        } catch (_) {
            return '';
        }
    }

    const apiOrigin = resolveApiOrigin();
    if (apiOrigin) {
        document.querySelectorAll('[data-product-link]').forEach((link) => {
            const url = new URL(link.getAttribute('href'), location.href);
            url.searchParams.set('api', apiOrigin);
            link.href = url.href;
        });
    }

    async function loadLiveCount() {
        try {
            const response = await fetch(`${apiOrigin}/api/health`, { headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const count = Number(data?.counts?.tokens);
            if (!Number.isFinite(count)) return;
            document.querySelectorAll('[data-live-token-count]').forEach((element) => {
                element.textContent = new Intl.NumberFormat('en-US').format(count);
            });
            const date = data.latestBuildAt ? new Date(data.latestBuildAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
            document.getElementById('liveSnapshot').textContent = `${date ? `Live catalogue · ${date}. ` : ''}Issuer-attributed and chain-observed token addresses; broad coverage, not a claim of exhaustiveness.`;
        } catch (_) {
            // The conservative static value remains visible when the API is offline.
        }
    }

    update(activeIndex, false);
    if (location.hash && slides[activeIndex]) requestAnimationFrame(() => {
        slides[activeIndex].scrollIntoView({ behavior: 'instant' });
    });
    loadLiveCount();
}());
