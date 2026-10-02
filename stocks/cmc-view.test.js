// The CoinMarketCap block on a token card (lib/cmc-view.js) and how a card wires it: rendered from
// a real answer of GET /api/tokens/:mint/cmc, asked for only when Markets opens.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const view = require('./lib/cmc-view.js');

const QUOTE = JSON.parse(readFileSync(join(__dirname, '..', 'api', 'test', 'fixtures', 'cmc', 'quote-aaplx.json'), 'utf8')).data['36994'];
const ANSWER = {
    mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', listed: true, source: 'CoinMarketCap', id: 36994,
    name: 'Apple tokenized stock (xStock)', symbol: 'AAPLX', url: 'https://coinmarketcap.com/currencies/apple-tokenized-stock-xstock/',
    price: QUOTE.quote.USD.price, volume24h: QUOTE.quote.USD.volume_24h, cexVolume24h: QUOTE.quote.USD.cex_volume_24h,
    dexVolume24h: QUOTE.quote.USD.dex_volume_24h, change1hPct: 0.42, change24hPct: -1.93, change7dPct: null, change30dPct: 3.84,
    marketCap: QUOTE.quote.USD.market_cap, marketPairs: QUOTE.num_market_pairs, rank: QUOTE.cmc_rank, lastUpdated: '2026-09-30T12:33:59.000Z'
};

describe('the CoinMarketCap block on a card', () => {
    test('shows price, changes, volume split into exchanges and DEX, market cap, pairs and rank, with CoinMarketCap’s own time and a link', () => {
        const html = view.cmcHtml(ANSWER);
        for (const label of ['Price', 'Change', 'Volume 24 h', 'Market cap', 'Market pairs', 'Rank']) expect(html).toContain(`<dt>${label}</dt>`);
        expect(html).toMatch(/<dd>\$[\d.,]+[kM]? \(exchanges \$[\d.,]+[kM]? · DEX \$[\d.,]+[kM]?\)<\/dd>/);
        expect(html).toContain('<dd>1 h +0.42% · 24 h -1.93% · 30 d +3.84%</dd>'); // the missing 7 d is left out, not 0
        expect(html).toContain('Updated 30 Sep 2026');
        expect(html).toContain('href="https://coinmarketcap.com/currencies/apple-tokenized-stock-xstock/"');
    });

    test('a token CoinMarketCap does not list says so; a figure it leaves empty is left out; a foreign link is not followed', () => {
        expect(view.cmcHtml({ listed: false })).toContain('does not list this exact token address');
        const sparse = view.cmcHtml({ ...ANSWER, marketCap: null, volume24h: null, url: 'https://evil.example/x' });
        expect(sparse).not.toContain('<dt>Market cap</dt>');
        expect(sparse).not.toContain('<dt>Volume 24 h</dt>');
        expect(sparse).not.toContain('evil.example');
    });

    test('the card asks for it only when Markets opens, through our API, and loads the view before card.js', () => {
        const card = readFileSync(join(__dirname, '..', 'card.js'), 'utf8');
        expect(card).toMatch(/block\.addEventListener\('toggle', load\)/);
        expect(card).toMatch(/if \(asked \|\| !block\.open\) return;/);
        expect(card).toContain("'/api/tokens/' + encodeURIComponent(section.getAttribute('data-mint')) + '/cmc'");
        const builder = readFileSync(join(__dirname, 'lib', 'cards.mjs'), 'utf8');
        expect(builder.indexOf('stocks/lib/cmc-view.js')).toBeLessThan(builder.indexOf('<script src="../card.js'));
        expect(builder).toContain('<section id="cmc" data-mint=');
        expect(builder).not.toMatch(/CMC_API_KEY/);
    });
});
