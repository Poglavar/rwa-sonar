/*
 * The CoinMarketCap part of a token card's Markets block: the HTML for one answer of
 * GET /api/tokens/:mint/cmc (api/src/routes/cmc.js). Pure: no DOM, no fetch. card.js asks for the
 * data only when the reader opens Markets, and renders it with this. UMD-wrapped like fmt.js,
 * exposing window.__rwaCmcView. Tested in ../cmc-view.test.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'));
    else root.__rwaCmcView = factory(root.__rwaFmt);
})(this, function (fmt) {
    'use strict';

    const { escapeHtml, fmtMoney, fmtNumber, fmtPrice, fmtSignedPct, fmtDateTime, isNum } = fmt;

    /** "$8.6M (exchanges $7.6M · DEX $991.3k)", or just the total when the split is missing. */
    function volumeText(a) {
        if (!isNum(a.volume24h)) return null;
        const split = isNum(a.cexVolume24h) && isNum(a.dexVolume24h)
            ? ` (exchanges ${fmtMoney(a.cexVolume24h)} · DEX ${fmtMoney(a.dexVolume24h)})` : '';
        return `${fmtMoney(a.volume24h)}${split}`;
    }

    function changesText(a) {
        const parts = [['1 h', a.change1hPct], ['24 h', a.change24hPct], ['7 d', a.change7dPct], ['30 d', a.change30dPct]]
            .filter(([, value]) => isNum(value)).map(([label, value]) => `${label} ${fmtSignedPct(value)}`);
        return parts.length ? parts.join(' · ') : null;
    }

    /** The block for one answer: figures CoinMarketCap left empty are left out, never shown as zero. */
    function cmcHtml(answer) {
        if (!answer || answer.listed !== true) {
            return '<p class="cmc-empty">CoinMarketCap does not list this exact token address.</p>';
        }
        const rows = [
            ['Price', isNum(answer.price) ? fmtPrice(answer.price) : null],
            ['Change', changesText(answer)],
            ['Volume 24 h', volumeText(answer)],
            ['Market cap', isNum(answer.marketCap) ? fmtMoney(answer.marketCap) : null],
            ['Market pairs', Number.isInteger(answer.marketPairs) ? fmtNumber(answer.marketPairs) : null],
            ['Rank', Number.isInteger(answer.rank) ? `#${fmtNumber(answer.rank)}` : null]
        ].filter(([, value]) => value !== null);
        const name = escapeHtml(answer.name ?? answer.symbol ?? 'this token');
        const link = typeof answer.url === 'string' && /^https:\/\/coinmarketcap\.com\//.test(answer.url)
            ? ` <a href="${escapeHtml(answer.url)}" rel="noopener">${name} on CoinMarketCap ↗</a>` : '';
        const updated = typeof answer.lastUpdated === 'string'
            ? `Updated ${escapeHtml(fmtDateTime(answer.lastUpdated))} by CoinMarketCap.` : 'CoinMarketCap gave no update time.';
        return `<dl class="kv">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`
            + `<p class="cmc-src">${updated} Across every market CoinMarketCap tracks, exchanges included.${link}</p>`;
    }

    return { cmcHtml, volumeText, changesText };
});
