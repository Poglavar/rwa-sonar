// The registry of hand-written public pages: one entry per page with its title, meta description,
// structured-data shape, breadcrumb and the live headline numbers its social image draws. The single
// source for stocks/build-site-seo.mjs (head regions, page images, sitemap) and for the SEO tests, so
// a new page is one entry here rather than a head block copied by hand. Pure: `stats(data)` and
// `lastmod(data)` read only the built files passed in and return null for anything missing.

import counts from './catalogue-counts.js';
import { fmtCount, fmtUsdShort } from './page-og.mjs';

const num = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const arr = (value) => Array.isArray(value) ? value : [];
const pct = (value) => num(value) === null ? null : `${value.toFixed(value >= 10 ? 0 : 1)}%`;

function programmes(d) {
    return Array.isArray(d.issuers?.issuers) ? counts.issuerProgrammeSummary(d.issuers.issuers) : null;
}

function tokenCount(d) {
    return Array.isArray(d.tokens?.tokens) ? d.tokens.tokens.length : null;
}

function documentedShare(d) {
    let documented = 0;
    let total = 0;
    for (const issuer of arr(d.issuers?.issuers)) {
        const c = issuer?.whatIfCounts;
        if (!c || typeof c !== 'object') continue;
        for (const value of Object.values(c)) if (num(value) !== null) total += value;
        documented += num(c.documented) ?? 0;
    }
    return total > 0 ? 100 * documented / total : null;
}

const LEARN_ROOT = { name: 'Learn', url: 'learn/' };

/**
 * `schema`: home | dataset | article | collection | webpage. `dataset.files` are the page's own
 * machine-readable sources (repo-relative, served at the same path). `crumbs` are the parents
 * between Home and the page. `facts` are static checklist lines for pages with no live number.
 */
export const SITE_PAGES = [
    {
        key: 'home', file: 'index.html', path: '',
        title: 'RWA Sonar — inspect tokenized stocks on Solana',
        description: 'The ticker is familiar. The token is mysterious. Compare Solana stock wrappers: holder rights, issuer controls, exits and the evidence behind each.',
        imageTitle: 'The ticker is familiar. The token is mysterious.',
        kicker: 'Tokenized stocks on Solana', subtitle: 'What the holder owns, who can intervene, where it can be used and how to exit — with the evidence.',
        schema: 'home',
        stats: (d) => [
            { value: fmtCount(tokenCount(d)), label: 'exact Solana token addresses' },
            { value: fmtCount(programmes(d)?.withTokens), label: 'issuer programmes with live tokens' },
            { value: fmtCount(arr(d.templates?.templates).length || null), label: 'legal + control templates' }
        ],
        lastmod: (d) => d.tokens?.builtAt
    },
    {
        key: 'stocks', file: 'stocks.html', path: 'stocks.html',
        title: 'Tokenized stocks on Solana — RWA Sonar',
        description: 'Compare every tokenized stock we can find on Solana by legal ownership, issuer controls, evidence quality, liquidity and market activity.',
        kicker: 'Stock workspace', subtitle: 'Search a ticker, compare its wrappers and open the exact token address behind each.',
        schema: 'dataset',
        dataset: {
            name: 'RWA Sonar catalogue of tokenized stocks on Solana',
            files: ['stocks-tokens.json', 'stocks-issuers.json', 'stocks-discovery.json', 'cards/index.json'],
            keywords: ['tokenized stocks', 'Solana', 'Token-2022', 'real-world assets', 'xStocks', 'Ondo Global Markets']
        },
        stats: (d) => [
            { value: fmtCount(tokenCount(d)), label: 'exact token addresses' },
            { value: fmtCount(programmes(d)?.total), label: 'programmes tracked, live or not' },
            { value: fmtCount(num(d.defi?.counts?.withAnyConfirmedUse)), label: 'tokens with confirmed DeFi use' }
        ],
        lastmod: (d) => d.tokens?.builtAt
    },
    {
        key: 'powers', file: 'powers.html', path: 'powers.html',
        title: 'Who can touch your tokens — RWA Sonar',
        description: 'For every tokenized-stock programme on Solana: who can mint, freeze, move, pause, rebase or upgrade your token — one key, a multisig, a program, or unknown.',
        kicker: 'Who holds the keys', subtitle: 'Issuer programmes × on-chain powers, each traced to the key, multisig or program that holds it.',
        schema: 'dataset', dataset: { name: 'Token-2022 authority holders per tokenized-stock programme', files: ['stocks-power-map.json'] },
        stats: (d) => [
            { value: fmtCount(num(d.powerMap?.counts?.['single-key'])), label: 'powers held by a single key', tone: 'warning' },
            { value: fmtCount(num(d.powerMap?.counts?.multisig)), label: 'powers held by a multisig' },
            { value: fmtCount(num(d.powerMap?.counts?.unknown)), label: 'holders not established', tone: 'caution' }
        ],
        lastmod: (d) => d.powerMap?.builtAt
    },
    {
        key: 'flows', file: 'flows.html', path: 'flows.html',
        title: 'Flows and float — RWA Sonar',
        description: 'Daily tokenized-stock creations and redemptions on Solana per issuer, with read coverage, and the real public float of xStocks net of issuer inventory.',
        kicker: 'Flows and float', subtitle: 'Created and redeemed per issuer per day, like ETF flows; missing coverage is never counted as zero.',
        schema: 'dataset', dataset: { name: 'Daily tokenized-stock creations, redemptions and public float', files: ['stocks-flows.json'] },
        stats: (d) => [
            { value: pct(num(d.flows?.float?.totals?.inventorySharePct)), label: 'of priced xStocks supply sits in issuer wallets', tone: 'caution' },
            { value: fmtUsdShort(num(d.flows?.float?.totals?.floatUsd)), label: 'xStocks public float (upper bound)' },
            { value: fmtCount(num(d.flows?.float?.totals?.pricedMints)), label: 'priced xStocks mints' }
        ],
        lastmod: (d) => d.flows?.builtAt
    },
    {
        key: 'tracking', file: 'tracking.html', path: 'tracking.html',
        title: 'Premium and concentration tracker — RWA Sonar',
        description: 'How far each tokenized-stock wrapper on Solana trades from its underlying share price, and which tokens sit in one wallet with nowhere to sell.',
        kicker: 'Premium and concentration', subtitle: 'Wrapper price versus the underlying, paired within one trading session, and the holder-concentration corner.',
        schema: 'dataset', dataset: { name: 'Tokenized-stock premium to underlying and holder concentration', files: ['stocks-tracking.json'] },
        stats: (d) => [
            { value: fmtCount(num(d.tracking?.premium?.counts?.underlyings)), label: 'underlyings with a reference price' },
            { value: fmtCount(num(d.tracking?.premium?.counts?.pairedTrades)), label: 'trades paired with a same-session price' },
            { value: fmtCount(num(d.tracking?.concentration?.counts?.inCorner)), label: 'tokens in one wallet with nowhere to sell', tone: 'warning' }
        ],
        lastmod: (d) => d.tracking?.generatedAt
    },
    {
        key: 'exits', file: 'exits.html', path: 'exits.html',
        title: 'Where can you exit? — RWA Sonar',
        description: 'For each tokenized stock on Solana: observed DEX liquidity by venue, the issuer redemption route and its evidence, and lending markets that accept it.',
        kicker: 'Exit routes', subtitle: 'Sell on a DEX, redeem with the issuer, or borrow against it — each route with its evidence.',
        schema: 'dataset', dataset: { name: 'Exit routes for tokenized stocks on Solana', files: ['stocks-exits.json'] },
        stats: (d) => {
            const tokens = arr(d.exits?.tokens);
            if (tokens.length === 0) return [];
            return [
                { value: fmtCount(tokens.filter((t) => num(t?.dexLiquidityUsd) !== null && t.dexLiquidityUsd > 0).length), label: 'tokens with observed DEX liquidity' },
                { value: fmtCount(tokens.filter((t) => arr(t?.lending).length > 0).length), label: 'tokens accepted by a lending market' },
                { value: fmtCount(tokens.filter((t) => t?.redemptionObservedForToken === true).length), label: 'with a redemption observed on-chain' }
            ];
        },
        lastmod: (d) => d.exits?.builtAt
    },
    {
        key: 'whatif', file: 'whatif.html', path: 'whatif.html',
        title: 'What if… — RWA Sonar',
        description: 'How each tokenized-stock issuer handles custodian failure, insolvency, stolen keys, corporate actions and other trust failures, answered from its own documents.',
        kicker: 'What if…', subtitle: 'The same failure scenarios put to every issuer: documented, inferred, litigated or unknown.',
        schema: 'dataset', dataset: { name: 'Failure-scenario answers per tokenized-stock issuer', files: ['stocks/data/trust-chain.json', 'stocks-issuers.json'] },
        stats: (d) => [
            { value: fmtCount(arr(d.trustChain?.failureModes).length || null), label: 'failure scenarios per issuer' },
            { value: fmtCount(arr(d.issuers?.issuers).length || null), label: 'programmes answering them' },
            { value: pct(documentedShare(d)), label: 'of answers quote the documents' }
        ],
        lastmod: (d) => d.issuers?.builtAt
    },
    {
        key: 'watch', file: 'watch.html', path: 'watch.html',
        title: 'Watch — RWA Sonar',
        description: 'The issuer documents and on-chain facts RWA Sonar watches, how fresh they are and what changed — plus private alerts for the tokens you follow.',
        kicker: 'Change watch', subtitle: 'Source-backed external changes ranked by holder impact; private Telegram alerts for your watches.',
        schema: 'dataset', dataset: { name: 'Public change journal for tokenized stocks on Solana', files: ['stocks-change-journal.json'] },
        stats: (d) => [
            { value: fmtCount(num(d.sources?.count)), label: 'cited sources checked daily' },
            { value: fmtCount(tokenCount(d)), label: 'token addresses read on-chain hourly' },
            { value: fmtCount(arr(d.journal?.items).length || null), label: 'external changes in the journal' }
        ],
        lastmod: (d) => d.journal?.generatedAt
    },
    {
        key: 'monitor', file: 'monitor.html', path: 'monitor.html',
        title: 'Health monitor — RWA Sonar',
        description: 'Monitor tokenized-stock price tracking, liquidity, holder concentration, authority controls and source changes on Solana, token by token.',
        kicker: 'Health monitor', subtitle: 'Each token on its own checks and on its programme’s; unknown never counts as good.',
        schema: 'dataset', dataset: { name: 'Tokenized-stock health checks', files: ['stocks-health.json'] },
        stats: (d) => [
            // The token's own checks (stocks/lib/health.mjs HEALTH_LEVELS): the issuer-wide checks rate
            // every token of a programme alike, so they are counted per programme on the page itself.
            { value: fmtCount(num(d.health?.byLevel?.token?.warning)), label: 'tokens failing a check of their own', tone: 'warning' },
            { value: fmtCount(num(d.health?.byLevel?.token?.caution)), label: 'tokens at caution on their own checks', tone: 'caution' },
            { value: fmtCount(num(d.health?.byLevel?.token?.good)), label: 'tokens passing every check on the token itself', tone: 'good' }
        ],
        lastmod: (d) => d.health?.generatedAt
    },
    {
        key: 'live', file: 'live.html', path: 'live.html',
        title: 'Live trades on the sampled pools — RWA Sonar',
        description: 'Recently decoded trades from the busiest Solana tokenized-stock pools, collected hourly, with a 24-hour replay and historical pages.',
        kicker: 'Trade tape', subtitle: 'Decoded DEX swaps on the busiest tokenized-stock pools, collected hourly on the server.',
        schema: 'dataset', dataset: { name: 'Decoded tokenized-stock DEX trades on Solana', files: ['stocks-trades.json'], api: ['api/trades/recent', 'api/trades/daily'] },
        stats: (d) => [
            { value: fmtCount(num(d.trades?.totals?.trades)), label: 'decoded trades in the last 24 h' },
            { value: fmtUsdShort(num(d.trades?.totals?.volumeUsd)), label: 'traded in the last 24 h' },
            { value: fmtCount(num(d.trades?.totals?.traders)), label: 'distinct trading wallets' }
        ],
        lastmod: (d) => d.trades?.generatedAt
    },
    {
        key: 'graph', file: 'graph.html', path: 'graph.html',
        title: 'The parties behind the programmes — RWA Sonar',
        description: 'Map the issuers, custodians, verifiers, transfer agents, distributors and trading venues behind tokenized stocks on Solana.',
        kicker: 'Parties graph', subtitle: 'Issuers, custodians, verifiers, transfer agents, distributors and venues, and how they connect.',
        schema: 'dataset', dataset: { name: 'Parties and relationships behind tokenized-stock programmes', files: ['stocks-graph.json'] },
        stats: (d) => [
            { value: fmtCount(arr(d.graph?.nodes).length || null), label: 'parties' },
            { value: fmtCount(arr(d.graph?.edges).length || null), label: 'relationships between them' },
            { value: fmtCount(arr(d.graph?.nodes).filter((n) => n?.type === 'custodian').length || null), label: 'custodians named' }
        ],
        lastmod: (d) => d.graph?.builtAt
    },
    {
        key: 'economics', file: 'economics.html', path: 'economics.html',
        title: 'Fees and incentives — RWA Sonar',
        description: 'Follow the money behind tokenized stocks: holder costs, who gets paid, contractual caps and long-term incentives, with sources and explicit gaps.',
        kicker: 'Fees and incentives', subtitle: 'Holder costs, actor compensation and caps per programme; no all-in fee is invented from partial coverage.',
        schema: 'dataset', dataset: { name: 'Tokenized-stock fees and incentives per issuer programme', files: ['stocks/data/economics.json'] },
        stats: (d) => [
            { value: fmtCount(arr(d.economics?.profiles).length || null), label: 'issuer programmes profiled' },
            { value: fmtCount(arr(d.economics?.profiles).reduce((sum, p) => sum + arr(p?.fees).length, 0) || null), label: 'fee lines with sources' }
        ],
        lastmod: () => null
    },
    {
        key: 'methodology', file: 'methodology.html', path: 'methodology.html',
        title: 'Methodology — how RWA Sonar evaluates tokenized stocks',
        description: 'How RWA Sonar discovers tokenized stocks on Solana, verifies legal and on-chain claims, monitors changes, grades evidence and reports data gaps.',
        kicker: 'Methodology', subtitle: 'Evidence precedence, collector freshness, health definitions and known blind spots.',
        schema: 'article',
        stats: (d) => [
            { value: fmtCount(arr(d.issuers?.issuers).reduce((sum, i) => sum + (num(i?.evidence?.claims) ?? 0), 0) || null), label: 'structured claims with a quote or source' },
            { value: fmtCount(num(d.sources?.count)), label: 'cited sources watched daily' },
            { value: fmtCount(arr(d.health?.rules).length || null), label: 'health checks, thresholds published' }
        ],
        lastmod: () => null
    },
    {
        key: 'review', file: 'review.html', path: 'review.html',
        title: 'Evidence review queue — RWA Sonar',
        description: 'The prioritized RWA Sonar research queue: missing, stale, conflicting and changed evidence behind tokenized-stock conclusions.',
        kicker: 'Evidence review queue', subtitle: 'Open evidence gaps and unresolved external changes, ranked by what they could change for a holder.',
        schema: 'dataset', dataset: { name: 'Open evidence review items for tokenized-stock research', files: ['stocks-review-queue.json'] },
        stats: (d) => {
            const s = d.review?.summary;
            if (!s) return [];
            return [
                { value: fmtCount(num(s.total)), label: 'open review items' },
                { value: fmtCount((num(s.byPriority?.P0) ?? 0) + (num(s.byPriority?.P1) ?? 0)), label: 'P0/P1: ownership, insolvency, redemption, control' },
                { value: fmtCount(num(s.byArea?.insolvency)), label: 'about insolvency' }
            ];
        },
        lastmod: (d) => d.review?.generatedAt
    },
    {
        key: 'learn', file: 'learn/index.html', path: 'learn/',
        title: 'Learn tokenized stocks — RWA Sonar',
        description: 'Plain-language guides to ownership, bankruptcy, redemption, issuer controls, oracle risk and DeFi custody for tokenized stocks.',
        kicker: 'Learn', subtitle: 'Six plain-language guides, each tied back to the fields and verdicts RWA Sonar shows.',
        schema: 'collection',
        facts: ['Do you own the share?', 'What if the issuer fails?', 'Can you turn it into cash?', 'Who can freeze or claw it back?']
    },
    {
        key: 'learn-beneficial-ownership', file: 'learn/beneficial-ownership.html', path: 'learn/beneficial-ownership.html',
        title: 'Do you own the share? Beneficial ownership explained — RWA Sonar',
        description: 'What holders own when a stock is tokenized: registered shares, beneficial interests, notes, unsecured claims and synthetic exposure, in plain language.',
        kicker: 'Learn · ownership', subtitle: 'Registered share, beneficial interest, note, unsecured claim or price exposure only.',
        schema: 'article', crumbs: [LEARN_ROOT],
        facts: ['Registered share on the official register', 'Beneficial interest through an intermediary', 'Secured or unsecured claim on the issuer', 'Price exposure only']
    },
    {
        key: 'learn-bankruptcy-remoteness', file: 'learn/bankruptcy-remoteness.html', path: 'learn/bankruptcy-remoteness.html',
        title: 'What if the issuer fails? Bankruptcy remoteness — RWA Sonar',
        description: 'A plain-language guide to bankruptcy remoteness, segregation, trusts, security interests and custodian risk in tokenized stocks.',
        kicker: 'Learn · insolvency', subtitle: 'Segregation, trusts, security interests and custodian risk when a party in the chain fails.',
        schema: 'article', crumbs: [LEARN_ROOT],
        facts: ['Is the collateral segregated?', 'Is there a security agent?', 'Who stands first if the issuer fails?']
    },
    {
        key: 'learn-redemption', file: 'learn/redemption.html', path: 'learn/redemption.html',
        title: 'Can you turn a tokenized stock into cash? Redemption — RWA Sonar',
        description: 'A plain-language guide to tokenized-stock redemption rights, eligibility, fees, minimums, settlement and secondary-market exits.',
        kicker: 'Learn · redemption', subtitle: 'Redemption rights, eligibility gates, fees, minimums, settlement and selling on a market.',
        schema: 'article', crumbs: [LEARN_ROOT],
        facts: ['A documented right is not an observed redemption', 'Eligibility can exclude you', 'Selling needs a market that is actually there']
    },
    {
        key: 'learn-issuer-control', file: 'learn/issuer-control.html', path: 'learn/issuer-control.html',
        title: 'Who can freeze or claw back a tokenized stock? — RWA Sonar',
        description: 'A plain-language guide to mint, freeze, pause, clawback, allowlist, transfer-fee, transfer-hook and rebase powers in tokenized stocks on Solana.',
        kicker: 'Learn · issuer powers', subtitle: 'Mint, freeze, pause, clawback, allowlist, transfer fees, hooks and rebasing on Token-2022.',
        schema: 'article', crumbs: [LEARN_ROOT],
        facts: ['Freeze and pause', 'Permanent delegate (clawback)', 'Rebasing multipliers', 'Who holds each key']
    },
    {
        key: 'learn-oracle-risk', file: 'learn/oracle-risk.html', path: 'learn/oracle-risk.html',
        title: 'Oracle and price risk in tokenized stocks — RWA Sonar',
        description: 'A plain-language guide to oracle prices, issuer NAV, underlying equity prices, pool prices, staleness and liquidation risk for tokenized stocks.',
        kicker: 'Learn · oracle risk', subtitle: 'Oracle prices, issuer NAV, pool prices, market hours, staleness and liquidation.',
        schema: 'article', crumbs: [LEARN_ROOT],
        facts: ['Which price does the protocol read?', 'What happens when the market is closed?', 'How stale can it get?']
    },
    {
        key: 'learn-defi-custody', file: 'learn/defi-custody.html', path: 'learn/defi-custody.html',
        title: 'Does DeFi custody mean legal control? Tokenized stocks — RWA Sonar',
        description: 'A plain-language guide to using tokenized stocks in DeFi: escrow, programmatic collateral, liquidation, issuer recognition, hacks and access loss.',
        kicker: 'Learn · DeFi custody', subtitle: 'Escrow, programmatic collateral, liquidation, issuer recognition, hacks and lost access.',
        schema: 'article', crumbs: [LEARN_ROOT],
        facts: ['Protocol custody is not legal ownership', 'Can a lender actually realise cash?', 'What if the protocol is hacked?']
    },
    {
        key: 'pitch', file: 'pitch/index.html', path: 'pitch/',
        title: 'RWA Sonar — Stocklana pitch',
        description: 'RWA Sonar pitch deck: evidence-backed diligence for tokenized stocks on Solana — the problem, the product, what is built and where it goes next.',
        socialDescription: 'Evidence-backed diligence for tokenized stocks on Solana.',
        imageTitle: 'Don’t trust the ticker. Inspect the token.',
        kicker: 'Pitch', subtitle: 'Evidence-backed diligence for tokenized stocks on Solana.',
        schema: 'webpage', contactVariant: 'dark',
        stats: (d) => [
            { value: fmtCount(tokenCount(d)), label: 'exact Solana token addresses' },
            { value: fmtCount(arr(d.templates?.templates).length || null), label: 'reviewed legal + control templates' },
            { value: fmtCount(arr(d.health?.rules).length || null), label: 'health checks' }
        ],
        lastmod: (d) => d.tokens?.builtAt
    },
    {
        key: 'assets', file: 'assets.html', path: 'assets.html',
        title: 'RWA asset explorer — RWA Sonar',
        description: 'The earlier general RWA catalogue: what tokenized real-world assets actually represent, who controls them and which trust assumptions holders accept.',
        kicker: 'General RWA explorer', subtitle: 'The pre-stocks catalogue of tokenized real-world assets across chains.',
        schema: 'dataset', dataset: { name: 'General tokenized real-world asset catalogue', files: ['rwa-assets-db.json'] },
        stats: (d) => [{ value: fmtCount(arr(d.assets).length || null), label: 'real-world asset records graded' }],
        lastmod: () => null
    }
];

/** The relative path from a page back to the site root: '' → './', 'learn/x.html' → '../'. */
export function rootOf(file) {
    const depth = file.split('/').length - 1;
    return depth === 0 ? './' : '../'.repeat(depth);
}

/** Absolute page URL for an origin. */
export function pageUrl(origin, page) {
    return `${origin}/${page.path}`;
}

/** Breadcrumb trail `[{name, url}]`, Home first. */
export function pageCrumbs(origin, page) {
    if (page.key === 'home') return [{ name: 'RWA Sonar', url: `${origin}/` }];
    const name = page.title.replace(/ — RWA Sonar$/, '').replace(/^RWA Sonar — /, '');
    return [{ name: 'RWA Sonar', url: `${origin}/` },
        ...(page.crumbs ?? []).map((crumb) => ({ name: crumb.name, url: `${origin}/${crumb.url}` })),
        { name, url: pageUrl(origin, page) }];
}
