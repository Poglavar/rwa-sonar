// Who keeps a token's price honest: the issuer's primary market (stocks/data/primary-market.json)
// read as a verdict. If many can create and redeem quickly, arbitrage pulls the token back to the
// share; if only a few can, they do it for everyone; if no one can, nothing ties the price to
// the share at all. Pure: validation for the build and the tests, per-token hours (Ondo mints six
// tokens 24/7 and the rest in market hours), the verdict, and the HTML the card's Markets block
// and the issuer page share.

import fmt from './fmt.js';

const { escapeHtml } = fmt;

export const WHO = ['anyone', 'onboarded', 'exchange-users', 'authorized-participants', 'market-makers', 'allowlisted-holders', 'nobody'];
export const MECHANISMS = ['onchain-program', 'broker-conversion', 'issuer-desk', 'burn-address', 'transfer-agent-portal', 'none'];
export const SETTLEMENTS = ['instant', 'minutes', 'days', 'unknown', 'none'];
export const HOURS = ['24/7', '24/5', 'market-hours', 'business-days', 'mixed', 'unknown', 'none'];
export const VERDICTS = ['anchored', 'anchored-by-few', 'anchored-slowly', 'floats', 'no-open-market'];

const TEXT_FIELDS = ['whoText', 'mechanismText', 'settlementText', 'hoursText', 'minimum', 'fee', 'inKindText'];
const FAST = new Set(['instant', 'minutes']);
const OPEN_TO_MANY = new Set(['anyone', 'onboarded', 'exchange-users']);

/** Every problem in the file, as "slug: what" lines; an empty list means the file is usable. */
export function validatePrimaryMarket(doc) {
    const problems = [];
    const issuers = doc?.issuers;
    if (!issuers || typeof issuers !== 'object') return ['issuers: missing'];
    for (const [slug, entry] of Object.entries(issuers)) {
        const bad = (what) => problems.push(`${slug}: ${what}`);
        if (!WHO.includes(entry?.who)) bad(`who must be one of ${WHO.join(', ')}`);
        if (!MECHANISMS.includes(entry?.mechanism)) bad(`mechanism must be one of ${MECHANISMS.join(', ')}`);
        if (!SETTLEMENTS.includes(entry?.settlement)) bad(`settlement must be one of ${SETTLEMENTS.join(', ')}`);
        if (!HOURS.includes(entry?.hours)) bad(`hours must be one of ${HOURS.join(', ')}`);
        for (const field of TEXT_FIELDS) {
            if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') bad(`${field} must be a non-empty string`);
        }
        for (const field of ['create', 'redeem', 'inKind']) {
            if (entry?.[field] !== null && typeof entry?.[field] !== 'boolean') bad(`${field} must be true, false or null`);
        }
        if (!Array.isArray(entry?.basis) || entry.basis.length === 0 || !entry.basis.every((b) => /^redemption\.\w+$/.test(b))) {
            bad('basis must name the dossier redemption fields it rests on');
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry?.checkedAt ?? ''))) bad('checkedAt must be a YYYY-MM-DD date');
        const ex = entry?.hoursExceptions;
        if (ex !== undefined && (!Array.isArray(ex?.symbols) || ex.symbols.length === 0 || !HOURS.includes(ex?.hours)
            || typeof ex?.hoursText !== 'string' || ex.hoursText.trim() === '')) {
            bad('hoursExceptions needs symbols[], hours and hoursText');
        }
        if ((entry?.who === 'nobody') !== (entry?.mechanism === 'none')) bad('who "nobody" and mechanism "none" go together');
    }
    return problems;
}

/** The hours that apply to one token: the issuer's, unless the entry lists this symbol as an exception. */
export function hoursFor(entry, symbol) {
    const ex = entry?.hoursExceptions;
    if (ex && Array.isArray(ex.symbols) && typeof symbol === 'string' && ex.symbols.includes(symbol)) {
        return { hours: ex.hours, hoursText: ex.hoursText };
    }
    return { hours: entry?.hours ?? 'unknown', hoursText: entry?.hoursText ?? 'Not published.' };
}

const WHO_WORDS = {
    anyone: 'anyone',
    onboarded: 'wallets the issuer has onboarded',
    'exchange-users': 'verified users of the issuer’s exchange',
    'authorized-participants': 'authorized participants',
    'market-makers': 'professional market makers',
    'allowlisted-holders': 'allowlisted holders',
    nobody: 'no one'
};

const HOURS_WORDS = {
    '24/7': 'around the clock',
    '24/5': 'on weekdays',
    'market-hours': 'in US market hours',
    'business-days': 'on business days',
    mixed: 'in US market hours',
    unknown: 'when the issuer is open',
    none: 'never'
};

const TONE = { anchored: 'good', 'anchored-by-few': 'good', 'anchored-slowly': 'caution', floats: 'warning', 'no-open-market': 'unknown' };

/**
 * The verdict for one token: `{verdict, tone, sentence, words}`. `sentence` opens the card section;
 * `words` is the short form for the Markets header ("arbitrage open to onboarded wallets").
 */
export function priceAnchor(entry, symbol) {
    const who = WHO_WORDS[entry.who] ?? 'the issuer';
    const { hours } = hoursFor(entry, symbol);
    const when = HOURS_WORDS[hours] ?? HOURS_WORDS.unknown;
    let verdict;
    let sentence;
    let words;
    if (entry.who === 'nobody' || entry.mechanism === 'none') {
        verdict = 'floats';
        sentence = 'No one can create or redeem, so nothing ties the price to the share: it is what the last trade paid.';
        words = 'no one can create or redeem: the price floats';
    } else if (entry.who === 'allowlisted-holders') {
        verdict = 'no-open-market';
        sentence = 'Only allowlisted wallets can hold or convert it and it has no open market, so there is no price to keep honest.';
        words = 'allowlisted, no open market';
    } else if (OPEN_TO_MANY.has(entry.who) && FAST.has(entry.settlement)) {
        verdict = 'anchored';
        sentence = hours === '24/7'
            ? `Arbitrage is open to ${who}, instantly and around the clock, so the price should stay close to the share.`
            : `Arbitrage is open to ${who} while the rail is open, so the price should track the share ${when}; outside them it floats.`;
        words = `arbitrage open to ${entry.who === 'exchange-users' ? 'verified exchange users' : entry.who === 'onboarded' ? 'onboarded wallets' : who}`;
    } else if (OPEN_TO_MANY.has(entry.who)) {
        verdict = 'anchored-slowly';
        sentence = `Many can create and redeem, but settlement takes ${entry.settlement === 'days' ? 'days' : 'an unpublished time'}, so the price can drift for days.`;
        words = 'arbitrage possible, but slow';
    } else {
        verdict = 'anchored-by-few';
        sentence = `Only ${who} can create and redeem, so they keep the price near the share ${when}; nobody else can arbitrage it.`;
        words = `only ${who} can arbitrage`;
    }
    return { verdict, tone: TONE[verdict], sentence, words };
}

/** The health checks' bands (lib/health.mjs): a premium past this is a warning, liquidity under this a warning. */
const PREMIUM_WARNING_PCT = 3;
const LIQUIDITY_WARNING_USD = 10000;

const money = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v).toLocaleString('en-US')}`);
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;

/**
 * The verdict checked against today's market, so the section never says "should track the share"
 * over a print that does not: a wide premium in a tiny pool is nobody bothering, a wide premium in
 * a real pool means the rail is idle or the reference stale, and a shut rail explains an
 * after-hours gap. Null when there is nothing to add. `premiumPct` and `liquidityUsd` are numbers
 * or null (a missing measurement adds nothing, never reads as 0).
 */
export function anchorObservation({ verdict, hours, premiumPct = null, liquidityUsd = null, marketOpen = null }) {
    const anchored = verdict === 'anchored' || verdict === 'anchored-by-few';
    if (!anchored) return null;
    const premium = typeof premiumPct === 'number' && Number.isFinite(premiumPct) ? premiumPct : null;
    const liquidity = typeof liquidityUsd === 'number' && Number.isFinite(liquidityUsd) ? liquidityUsd : null;
    if (premium !== null && Math.abs(premium) >= PREMIUM_WARNING_PCT) {
        if (liquidity !== null && liquidity < LIQUIDITY_WARNING_USD) {
            return `Today’s DEX price is ${signed(premium)} off the share, in a pool holding ${money(liquidity)}: too small for anyone to bother arbitraging, not a sign the rail failed.`;
        }
        if (marketOpen === false && hours !== '24/7') {
            return `Today’s DEX price is ${signed(premium)} off the share while US markets are closed and the rail is shut; the gap floats until they open.`;
        }
        return `Yet today’s DEX price is ${signed(premium)} off the share${liquidity === null ? '' : ` with ${money(liquidity)} of liquidity`}: the rail is not being used right now, or the reference price is stale.`;
    }
    if (marketOpen === false && hours !== '24/7') return 'US markets are closed now, so the rail is shut and the price floats until they open.';
    return null;
}

/** One token's record: the entry with its hours resolved and the verdict attached; null without an entry. */
export function shapePrimaryMarket(entry, symbol) {
    if (!entry || typeof entry !== 'object') return null;
    const { hoursExceptions, ...rest } = entry;
    const hours = hoursFor(entry, symbol);
    // At programme level (no symbol: the issuer page) the exceptions are named instead of resolved.
    if (symbol === null && hoursExceptions?.symbols?.length) {
        hours.hoursText = `${hours.hoursText} ${hoursExceptions.symbols.length} tokens (${hoursExceptions.symbols.join(', ')}) `
            + `${hoursExceptions.hours === '24/7' ? 'mint and redeem 24/7' : `run ${hoursExceptions.hours}`}.`;
    }
    return { ...rest, ...hours, anchor: priceAnchor(entry, symbol) };
}

/**
 * The "Who keeps the price honest" section body: the verdict, then the facts. `seenOnChain` is the
 * recurring redemption scan's line when the programme has one; `termsHref` links the full terms;
 * `listClass` is the page's definition-list class (`kv` on cards, `facts` on issuer pages);
 * `observation` is anchorObservation's sentence for this token's market today.
 */
export function primaryMarketHtml(shaped, { seenOnChain = null, termsHref = '#rights', listClass = 'kv', observation = null } = {}) {
    if (!shaped) return '';
    const a = shaped.anchor;
    const rows = [
        ['Who can create and redeem', shaped.whoText],
        ['How', shaped.mechanismText],
        ['How fast', shaped.settlementText],
        ['When', shaped.hoursText],
        ['Minimum', shaped.minimum],
        ['Cost', shaped.fee],
        // The text already opens with the answer ("Yes: …", "No.", "Cash only …", "Not published.").
        ['Shares or cash', shaped.inKindText],
        seenOnChain ? ['Seen on chain', seenOnChain] : null
    ].filter(Boolean);
    return `<p class="price-anchor price-anchor-${escapeHtml(a.tone)}"><strong>${escapeHtml(a.sentence)}</strong>`
        + `${shaped.anchorNote ? ` ${escapeHtml(shaped.anchorNote)}` : ''}${observation ? ` ${escapeHtml(observation)}` : ''}</p>`
        + `<dl class="${escapeHtml(listClass)}">${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`
        + `<p class="method">Read on ${escapeHtml(shaped.checkedAt)} from the issuer’s redemption terms; the terms and their sources are under `
        + `<a href="${escapeHtml(termsHref)}">Can a holder redeem?</a>.</p>`;
}
