// Which company a pre-IPO token references, and the key its comparison is grouped under. PreStocks
// and Tessera tokens have no listed ticker, so without this OPENAI and tOpenAI never meet. Pure:
// build-stocks-db.mjs stamps the result on each private-company token; tested in
// ../private-companies.test.js.

/**
 * One row per company a catalogued pre-IPO token references, spelled as the issuers spell it:
 * PreStocks names a token "<Company> PreStocks" (symbol OPENAI), Tessera "T-<Company>" (code
 * tOpenAI). `names` are compared without case, spaces or punctuation.
 *
 * A company that has since listed carries `listedTicker`, and its key IS that ticker, so its
 * pre-IPO tokens sit in the same comparison as the listed wrappers: SpaceX listed as SPCX on
 * 2026-06-12 (backpack-securities-spcx.json products; Backpack, xStocks, Ondo and Shift SPCX
 * tokens), and PreStocks' SPACEX and Tessera's tSpaceX still reference the same company.
 * An unlisted key must never equal a listed ticker (tested against the catalogue).
 */
export const PRIVATE_COMPANIES = [
    { key: 'OPENAI', name: 'OpenAI', names: ['OpenAI', 'Open AI'] },
    { key: 'SPCX', name: 'SpaceX', listedTicker: 'SPCX', names: ['SpaceX', 'Space Exploration Technologies'] },
    { key: 'KALSHI', name: 'Kalshi', names: ['Kalshi'] },
    { key: 'ANTHROPIC', name: 'Anthropic', names: ['Anthropic'] },
    { key: 'ANDURIL', name: 'Anduril', names: ['Anduril', 'Anduril Industries'] },
    { key: 'FIGUREAI', name: 'Figure AI', names: ['Figure AI'] },
    { key: 'NEURALINK', name: 'Neuralink', names: ['Neuralink'] },
    { key: 'POLYMARKET', name: 'Polymarket', names: ['Polymarket'] }
];

function squash(value) {
    return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

const BY_NAME = new Map(PRIVATE_COMPANIES.flatMap((company) => company.names.map((name) => [squash(name), company])));

/** "OpenAI PreStocks" -> "OpenAI", "T-OpenAI" -> "OpenAI", "tOpenAI" -> "OpenAI": the wrapper's words off. */
function bareName(value) {
    return typeof value === 'string'
        ? value.trim().replace(/\s+PreStocks$/i, '').replace(/^T-(?=\S)/, '').replace(/^t(?=[A-Z])/, '')
        : '';
}

/**
 * `{key, name, listedTicker}` for the company a pre-IPO token references, from its catalogue
 * name, its issuer API name or code, or its symbol, in that order; null when the table does not
 * name the company (a new token stays ungrouped rather than guessed into someone else's group).
 */
export function privateCompany(token) {
    if (!token || typeof token !== 'object') return null;
    const candidates = [token.name, token.issuerApi?.name, token.issuerApi?.code, token.symbol];
    for (const candidate of candidates) {
        const company = BY_NAME.get(squash(bareName(candidate)));
        if (company) return { key: company.key, name: company.name, listedTicker: company.listedTicker ?? null };
    }
    return null;
}
