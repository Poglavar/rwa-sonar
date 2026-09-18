#!/usr/bin/env node
// Joins the machine-collected data files (universe, on-chain mint state, sponsor APIs, reference
// prices and the venue records) with the hand-researched issuer dossiers and writes the three repo-root
// files the stocks page reads (MODEL.md §10.1): stocks-issuers.json, one full record per issuer with its
// grades, control surface and market reality, stocks-tokens.json, one record per mint plus a
// small issuerIndex so the table can label a row before the issuer file is even needed, and the tiny
// stocks-funnel.json the funnel graphic draws. Every rule
// it applies lives in lib/grade.mjs, lib/recipe.mjs and lib/funnel.mjs; this file only reads, joins,
// sorts and reports. The issuer record schema is MODEL.md §7.

import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import {
    byString, log, logError, logWarn, parseArgs, readJson, ts, writeJson
} from './lib/io.mjs';
import {
    VERIFICATION_STRENGTH, claimRung, controlSurface, instrumentType, issuerActivity, marketReality,
    maturityScore, maturityStage, maturityStageNum, median, supplyUi, tokenActivity,
    verificationStrength
} from './lib/grade.mjs';

import { issuerLabel } from './lib/classify.mjs';
import { CLAIM_FIELDS, dossierClaims, needed, summarise } from './lib/evidence.mjs';
import { controlRecipe, recipeTally } from './lib/recipe.mjs';
import { buildFunnel } from './lib/funnel.mjs';
import { TRUST_CHAIN, buildChain, whatIfIndex } from './lib/trustchain.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const DATA_DIR = join(HERE, 'data');
const DEFAULT_OUT_DIR = REPO_ROOT;
const ISSUERS_FILE = 'stocks-issuers.json';
const TOKENS_FILE = 'stocks-tokens.json';
const FUNNEL_FILE = 'stocks-funnel.json';

/**
 * Dossier file base → the issuer slug the machine data uses (universe.json `issuer`). Only the
 * three dossiers whose filename carries a ticker need mapping; every other file name is the slug.
 */
const DOSSIER_SLUGS = {
    'backpack-securities-spcx': 'backpack-securities',
    'bullish-blsh': 'bullish',
    'securitize-secz': 'securitize'
};

/**
 * Fallback lifecycle status while the dossiers are still gaining their own `status` field
 * (MODEL.md §1.4 and §4 both record these two as defunct). A dossier's own `status` always wins.
 */
const DEFUNCT_PER_MODEL = new Set(['remora-markets', 'ventuals']);

const UNKNOWN_KEY_GOVERNANCE = {
    mint: 'unknown', freeze: 'unknown', delegate: 'unknown', rebase: 'unknown', evidence: null
};
const FREEZE_EXERCISED_FINDING = 'freeze-authority-has-been-exercised';

function usage() {
    console.log(`build-stocks-db.mjs — join the stocks data files into ${ISSUERS_FILE} + ${TOKENS_FILE} + ${FUNNEL_FILE}

USAGE
  node stocks/build-stocks-db.mjs --run [options]

OPTIONS
  --run            Actually build. Without it this help is printed and nothing runs.
  --out-dir=<dir>  Where the three output files go (default ${DEFAULT_OUT_DIR}).
  --data=<dir>     Directory holding universe/onchain/sponsor-apis/reference-prices.json
                   and issuers/ (default ${DATA_DIR}).
  --help           This text.

INPUTS
  data/universe.json          one record per mint, from Jupiter (npm run stocks:universe)
  data/onchain.json           Token-2022 mint state per mint (npm run stocks:onchain)
  data/sponsor-apis.json      issuer-run APIs, keyed by sponsor (npm run stocks:sponsors)
  data/reference-prices.json  independent reference price and premium (npm run stocks:prices)
  data/venues.json            DEX pairs and CEX markets per mint (npm run stocks:venues) — OPTIONAL:
                              without it the build warns and every venue-derived activity field is
                              null, rather than reading as "trades nowhere"
  data/holders.json           top-20 token accounts and supply concentration per mint
                              (npm run stocks:holders) — OPTIONAL, same rule: without it every
                              token's holders block is null rather than "nobody holds it"
  data/issuers/<slug>.json    the hand-researched dossiers

NOTES
  Tokens are joined by mint; Ondo's API items are joined on ticker === underlyingTicker and only
  for Ondo tokens. Issuers are sorted by slug and tokens by mint, so a rebuild with unchanged
  inputs produces unchanged files. The two files carry the same builtAt and the same sources
  envelope; ${TOKENS_FILE} additionally carries issuerIndex, six display fields per issuer
  and no dossier prose, so the page can render the table without the issuer file. Headline totals
  cover live issuers only; a defunct issuer is still written out, with whatever mints the universe
  still holds. Nothing is written until every input has been read, so a missing fetcher output
  fails the run instead of truncating either file. ${TOKENS_FILE} is written with a one-space
  indent because it has a byte budget (under 1 MB) and the activity block spends ~170 kB of it.

  ${FUNNEL_FILE} is the third, tiny (~4 kB) output: the four-column funnel the stocks page draws
  above the grid — mints by instrument type, issuer programmes, control recipes and token programs,
  with one edge per step carrying the number of mints that take it (lib/funnel.mjs). It is built
  here, not counted in the browser, so the graphic cannot disagree with these two files.`);
}

/** Reads one required input, naming the fetcher that produces it if it is not there. */
async function readInput(path, hint) {
    const value = await readJson(path, null);
    if (value === null) throw new Error(`missing input ${path} — run ${hint} first`);
    return value;
}

async function readDossiers(dir) {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort(byString);
    const dossiers = [];
    for (const file of files) {
        const base = file.replace(/\.json$/, '');
        const slug = DOSSIER_SLUGS[base] ?? base;
        dossiers.push({ slug, file, dossier: await readJson(join(dir, file)) });
    }
    return dossiers.sort((a, b) => byString(a.slug, b.slug));
}

function indexByMint(items) {
    const index = new Map();
    for (const item of items) {
        if (item && typeof item.mint === 'string') index.set(item.mint, item);
    }
    return index;
}

/**
 * Sponsor payloads have different shapes, so each is indexed the way MODEL.md §9 specifies:
 * Superstate, PreStocks and Tessera publish the mint, Ondo publishes only the underlying ticker.
 */
function indexSponsors(sponsorItems) {
    const byMint = new Map();
    for (const source of ['superstate', 'prestocks', 'tessera']) {
        for (const item of sponsorItems?.[source] ?? []) {
            if (item && typeof item.mint === 'string') byMint.set(item.mint, item);
        }
    }
    const ondoByTicker = new Map();
    for (const item of sponsorItems?.ondo ?? []) {
        if (item && typeof item.ticker === 'string') ondoByTicker.set(item.ticker, item);
    }
    return { byMint, ondoByTicker };
}

/** Σ that yields null when nothing was finite, so an unknown volume never reads as zero. */
function sumFinite(values) {
    let total = null;
    for (const value of values) {
        if (Number.isFinite(value)) total = (total ?? 0) + value;
    }
    return total;
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

/**
 * The slim concentration block from `data/holders.json` (MODEL.md §10.1): the four cumulative
 * shares, how many WALLETS the top 20 token accounts are, how many of them the issuer has frozen,
 * and the label of the largest one. `null` when the mint has no holders item at all, which reads as
 * "not collected" rather than "nobody holds it".
 *
 * The `top20` list itself is deliberately NOT carried over: 441 mints × up to 20 accounts is ~1.8 MB
 * of the 2.4 MB holders.json, and stocks-tokens.json has a byte budget the page depends on. A
 * consumer that wants the accounts reads holders.json.
 */
function tokenHolders(holdersItem, fetchedAt) {
    if (holdersItem === null || holdersItem === undefined) return null;
    const largest = Array.isArray(holdersItem.top20) ? holdersItem.top20[0] ?? null : null;
    return {
        supplyUi: finiteOrNull(holdersItem.supplyUi),
        top1SharePct: finiteOrNull(holdersItem.top1SharePct),
        top5SharePct: finiteOrNull(holdersItem.top5SharePct),
        top20SharePct: finiteOrNull(holdersItem.top20SharePct),
        distinctOwnersTop20: finiteOrNull(holdersItem.distinctOwnersTop20),
        frozenAccountsTop20: finiteOrNull(holdersItem.frozenAccountsTop20),
        top1OwnerLabel: largest?.ownerLabel ?? null,
        fetchedAt
    };
}

function buildToken(universeItem, onchain, reference, sponsors, venuesItem, venuesAsOf, holdersItem, holdersAsOf) {
    const stats = universeItem.stats24h ?? null;
    const issuerApi = universeItem.issuer === 'ondo-global-markets'
        ? sponsors.ondoByTicker.get(universeItem.underlyingTicker) ?? null
        : sponsors.byMint.get(universeItem.mint) ?? null;

    const decimals = Number.isInteger(onchain?.decimals) ? onchain.decimals
        : Number.isInteger(universeItem.decimals) ? universeItem.decimals : null;
    const supplyRaw = typeof onchain?.supply === 'string' ? onchain.supply : null;
    const uiMultiplier = onchain?.scaledUiAmountMultiplier ?? null;

    const vol24 = sumFinite([stats?.buyVolume, stats?.sellVolume]);
    const organicVol24 = sumFinite([stats?.buyOrganicVolume, stats?.sellOrganicVolume]);

    const tokenProgram = onchain?.tokenProgram ?? universeItem.tokenProgram ?? null;
    const control = {
        clawback: onchain ? onchain.permanentDelegate === true : null,
        freezeAuthority: onchain?.freezeAuthority ?? null,
        pausable: onchain ? onchain.pausable === true : null,
        paused: typeof onchain?.paused === 'boolean' ? onchain.paused : null,
        allowlist: onchain ? onchain.defaultAccountStateFrozen === true : null,
        transferFeeBps: finiteOrNull(onchain?.transferFeeBps),
        hookActive: onchain ? typeof onchain.transferHookProgram === 'string' : null,
        // The scaled-UI-amount (rebase) extension being installed at all — NOT whether the
        // multiplier is currently 1. A multiplier of 1 is a rebase that has not been used yet, and
        // the capability is what the recipe and the keyControl health rule are about (MODEL.md
        // §2.7): one signature from the rebase authority restates every holder's displayed balance.
        rebase: onchain ? typeof onchain.scaledUiAmountMultiplier === 'string' : null
    };

    return {
        mint: universeItem.mint,
        symbol: universeItem.symbol ?? null,
        name: universeItem.name ?? null,
        issuer: universeItem.issuer ?? null,
        underlyingTicker: universeItem.underlyingTicker ?? null,
        instrumentType: instrumentType(universeItem, issuerApi),
        listedOnJupiter: universeItem.listedOnJupiter === true,
        // Universe provenance (stocks/lib/universe.mjs): when the search first and last returned
        // this mint, and whether the LAST run returned it at all. `seenInSearch: false` means the
        // market numbers above are the last ones we saw, not today's — a stale row, not a delisting.
        // A record written before these fields existed leaves them null rather than claiming today.
        firstSeenAt: typeof universeItem.firstSeenAt === 'string' ? universeItem.firstSeenAt : null,
        lastSeenAt: typeof universeItem.lastSeenAt === 'string' ? universeItem.lastSeenAt : null,
        seenInSearch: typeof universeItem.seenInSearch === 'boolean' ? universeItem.seenInSearch : null,
        decimals,
        supplyRaw,
        uiMultiplier,
        supplyUi: supplyUi(supplyRaw, decimals, uiMultiplier),
        tokenProgram,
        metadataUri: onchain?.metadataUri ?? null,
        control,
        // The control recipe (lib/recipe.mjs): the program plus the extensions that are ON, as one
        // label. It is what the funnel groups by, and it is capability — what the issuer can
        // technically do to the mint — not what the holder owns.
        recipe: controlRecipe({ tokenProgram, control }),
        market: {
            usdPrice: finiteOrNull(universeItem.usdPrice),
            mcap: finiteOrNull(universeItem.mcap),
            liquidity: finiteOrNull(universeItem.liquidity),
            holderCount: finiteOrNull(universeItem.holderCount),
            vol24,
            organicVol24,
            organicSharePct: Number.isFinite(organicVol24) && Number.isFinite(vol24) && vol24 > 0
                ? (organicVol24 / vol24) * 100
                : null,
            traders24: finiteOrNull(stats?.numTraders),
            top10HolderPct: finiteOrNull(universeItem.audit?.topHoldersPercentage),
            firstPoolAt: universeItem.firstPool?.createdAt ?? null
        },
        activity: tokenActivity(universeItem, venuesItem, { asOf: venuesAsOf }),
        holders: tokenHolders(holdersItem, holdersAsOf),
        reference: {
            source: reference?.refSource ?? null,
            price: finiteOrNull(reference?.refPrice),
            premiumPct: finiteOrNull(reference?.premiumPct),
            marketOpen: typeof reference?.marketOpen === 'boolean' ? reference.marketOpen : null,
            ageSeconds: finiteOrNull(reference?.refAgeSeconds),
            note: reference?.note ?? null
        },
        issuerApi
    };
}

function statusOf(slug, dossier) {
    if (typeof dossier.status === 'string' && dossier.status.trim() !== '') return dossier.status.trim();
    return DEFUNCT_PER_MODEL.has(slug) ? 'defunct' : 'live';
}

function freezeExercisedOf(findings) {
    return findings.some((f) => f?.schema === FREEZE_EXERCISED_FINDING) ? 'yes' : 'unknown';
}

function buildIssuer({ slug, dossier }, tokens, onchainItems, prices, venuesItems) {
    const findings = Array.isArray(dossier.findings) ? dossier.findings : [];
    const keyGovernance = dossier.keyGovernance ?? { ...UNKNOWN_KEY_GOVERNANCE };
    const claim = claimRung(dossier);
    const verification = verificationStrength(dossier);
    // The dossier's own claims[] plus every quote-bearing finding, incident and attestation
    // (stocks/EVIDENCE.md §4). Counted against the SAME record the page renders, so the coverage
    // line on the panel, on a card and in stocks-issuers.json can never disagree: the needed-field
    // list is stocks/data/claim-fields.json expanded against this record's own keys.
    const claims = dossierClaims(slug, dossier);

    const record = {
        slug,
        name: issuerLabel(slug),
        issuerText: dossier.issuer ?? null,
        status: statusOf(slug, dossier),
        chains: dossier.chains ?? [],
        products: dossier.products ?? [],
        issuingEntity: dossier.issuingEntity ?? null,
        entityJurisdiction: dossier.entityJurisdiction ?? null,
        governingLaw: dossier.governingLaw ?? null,
        regulatoryStatus: dossier.regulatoryStatus ?? null,
        legalForm: dossier.legalForm ?? null,
        holderClaim: dossier.holderClaim ?? null,
        underlyingCustodian: dossier.underlyingCustodian ?? null,
        collateral: dossier.collateral ?? null,
        custodyVerification: dossier.custodyVerification ?? null,
        securityInterest: dossier.securityInterest ?? null,
        bankruptcyRemote: dossier.bankruptcyRemote ?? null,
        redemption: dossier.redemption ?? null,
        transferRestrictions: dossier.transferRestrictions ?? null,
        dividends: dossier.dividends ?? null,
        voting: dossier.voting ?? null,
        corporateActions: dossier.corporateActions ?? null,
        pricing: dossier.pricing ?? null,
        venues: dossier.venues ?? [],
        incidents: dossier.incidents ?? [],
        documents: dossier.documents ?? [],
        openQuestions: dossier.openQuestions ?? [],
        confidence: dossier.confidence ?? null,
        sources: dossier.sources ?? [],
        keyGovernance,
        vocabulary: dossier.vocabulary ?? {},
        attestations: Array.isArray(dossier.attestations) ? dossier.attestations : [],
        findings,
        grades: {
            maturityStageNum: maturityStageNum(dossier.vocabulary),
            maturityStage: maturityStage(dossier.vocabulary),
            maturityScore: maturityScore(dossier.vocabulary),
            claimRung: claim.rung,
            claimLabel: claim.label,
            verificationStrength: verification.strength,
            verificationLabel: verification.label,
            machineReadableVerification: verification.machineReadable
        },
        control: { ...controlSurface(onchainItems), keyGovernance, freezeExercised: freezeExercisedOf(findings) },
        // The distinct control recipes across this issuer's mints, with a mint count each. The
        // counts always sum to tokenMints.length: every mint has exactly one recipe, and a mint we
        // have not read from the chain yet is counted under the 'unknown' label rather than dropped.
        recipes: recipeTally(tokens),
        market: marketReality(tokens, prices),
        activity: issuerActivity(tokens, venuesItems),
        tokenMints: tokens.map((t) => t.mint)
    };

    // `tokenProgram` is on the need list (the research brief) but was not on the record, so no
    // claim on it could ever have been counted. It is the program the ISSUER says it uses, which
    // is worth publishing beside what the chain reports per mint.
    record.tokenProgram = dossier.tokenProgram ?? null;
    // `parties` and `knownExtensions` are here for the same reason `tokenProgram` is: the trust
    // chain rests on them (`parties.*` fills every node, `knownExtensions` is one of the fields
    // the transfer flow is graded on), and the chain has to be REBUILDABLE from this record alone
    // — that is what api/src/routes/whatif.js does with the stored `record` jsonb. Neither is on
    // stocks/data/claim-fields.json, so adding them does not move any coverage denominator.
    record.parties = dossier.parties ?? {};
    record.knownExtensions = Array.isArray(dossier.knownExtensions) ? dossier.knownExtensions : [];
    record.claims = claims;
    record.evidenceFields = needed(record, CLAIM_FIELDS);
    record.evidence = summarise(record, claims, CLAIM_FIELDS);
    // The trust chain (stocks/data/trust-chain.json): a node per actor, a link per rights flow,
    // each link graded twice from the claims above. Built from `record`, not from `dossier`, so
    // the API rebuilding it from the stored record gets byte-identical output.
    record.chain = buildChain(record, TRUST_CHAIN, { claims });
    // Only the COUNTS of the what-if answers, never the entries: the full answers are prose with
    // quotes and case citations, they are already in the dossier, and the API serves them from
    // sonar.what_if. Inlining 38 of them per issuer would be most of this file.
    record.whatIfCounts = whatIfIndex(dossier, TRUST_CHAIN).counts;
    return record;
}

/**
 * The six display fields the token table needs per issuer (MODEL.md §10.1). Deliberately carries no
 * dossier prose — no documents, attestations, findings or vocabulary — so stocks-tokens.json stays
 * small and the page never has to wait for the issuer file to label a row.
 */
function issuerIndexEntry(issuer) {
    return {
        slug: issuer.slug,
        name: issuer.name,
        status: issuer.status,
        legalForm: issuer.legalForm,
        claimRung: issuer.grades.claimRung,
        maturityStageNum: issuer.grades.maturityStageNum,
        // The evidence SUMMARY only — never the claims array, which carries verbatim quotes and
        // would cost the byte budget this index exists to protect.
        evidence: issuer.evidence
    };
}

function usd(value) {
    if (!Number.isFinite(value)) return 'n/a';
    if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
    if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
    return `$${value.toFixed(0)}`;
}

function pct(value, digits = 1) {
    return Number.isFinite(value) ? `${value.toFixed(digits)}%` : 'n/a';
}

/** The on-disk size of a written file, so the byte budget is reported by the build itself. */
async function kb(path) {
    const { size } = await stat(path);
    return `${(size / 1024).toFixed(0)} kB`;
}

function num(value, digits = 0) {
    return Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : 'n/a';
}

/** MODEL.md §11.3 — the row the page's Trading activity table shows, printed by the build itself. */
function summariseActivity(issuer) {
    const a = issuer.activity;
    return [
        issuer.slug.padEnd(24),
        `${String(a.tokensTraded24).padStart(3)}/${String(a.tokens).padEnd(3)} traded`,
        `trades ${num(a.trades24).padStart(9)}`,
        `traders ${num(a.traders24).padStart(7)}`,
        `t/trader ${num(a.tradesPerTrader, 1).padStart(7)}`,
        `organic ${pct(a.organicSharePct).padStart(7)}`,
        `spread ${pct(a.venueSpreadMedianPct, 2).padStart(7)}`,
        `venues ${String(a.venueCount ?? 'n/a').padStart(3)}`,
        `last ${a.lastTradedAt ?? 'n/a'}${a.lastTradedVenue ? ` (${a.lastTradedVenue})` : ''}`
    ].join(' ');
}

function summariseIssuer(issuer) {
    const g = issuer.grades;
    const m = issuer.market;
    return [
        issuer.slug.padEnd(24),
        issuer.status.padEnd(8),
        `${g.maturityStage} score ${g.maturityScore >= 0 ? '+' : ''}${g.maturityScore}`.padEnd(20),
        `claim ${g.claimRung ?? '?'} (${g.claimLabel ?? 'unknown'})`.padEnd(42),
        `verification ${g.verificationStrength ?? '?'} (${g.verificationLabel ?? 'unknown'}${g.machineReadableVerification ? ', machine-readable' : ''})`.padEnd(42),
        `${String(m.tokens).padStart(3)} token(s)`,
        `liq ${usd(m.dexLiquidityUsd)}`,
        `vol24 ${usd(m.vol24Usd)}`,
        `holders ${Number.isFinite(m.holdersSum) ? m.holdersSum : 'n/a'}`,
        `premium ${pct(m.premiumMedianPct, 2)} (n=${m.premiumSampleSize})`,
        `zeroVol ${pct(Number.isFinite(m.zeroVolumeShare) ? m.zeroVolumeShare * 100 : null, 0)}`,
        `paused ${m.pausedTokens}`
    ].join(' ');
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }

    const dataDir = typeof flags.data === 'string' ? flags.data : DATA_DIR;
    const outDir = typeof flags['out-dir'] === 'string' ? flags['out-dir'] : DEFAULT_OUT_DIR;
    const issuersDir = join(dataDir, 'issuers');

    const universe = await readInput(join(dataDir, 'universe.json'), 'npm run stocks:universe');
    const onchain = await readInput(join(dataDir, 'onchain.json'), 'npm run stocks:onchain');
    const sponsorApis = await readInput(join(dataDir, 'sponsor-apis.json'), 'npm run stocks:sponsors');
    const referencePrices = await readInput(join(dataDir, 'reference-prices.json'), 'npm run stocks:prices');
    // The one OPTIONAL input: without it every venue-derived activity field stays null (§11.2),
    // which reads as "not collected" rather than "trades nowhere".
    const venuesPath = join(dataDir, 'venues.json');
    const venues = await readJson(venuesPath, null);
    if (venues === null) {
        logWarn(`no ${venuesPath} — run npm run stocks:venues; every token's venue and last-trade field is null in this build`);
    }
    // The second OPTIONAL input, same rule: a missing holders.json leaves every `holders` block
    // null, which reads as "not collected" rather than "nobody holds it".
    const holdersPath = join(dataDir, 'holders.json');
    const holders = await readJson(holdersPath, null);
    if (holders === null) {
        logWarn(`no ${holdersPath} — run npm run stocks:holders; every token's holders block is null in this build`);
    }
    const dossiers = await readDossiers(issuersDir);
    log(`read ${universe.items.length} universe token(s), ${onchain.items.length} on-chain mint(s), ${referencePrices.items.length} reference price(s), ${dossiers.length} dossier(s)`);

    const onchainByMint = indexByMint(onchain.items);
    const referenceByMint = indexByMint(referencePrices.items);
    const venuesByMint = indexByMint(Array.isArray(venues?.items) ? venues.items : []);
    const holdersByMint = indexByMint(Array.isArray(holders?.items) ? holders.items : []);
    const holdersAsOf = holders?.fetchedAt ?? null;
    // Every staleness decision in the price spread is measured from when the venues file was
    // FETCHED, never from the clock, so rebuilding today's data next month grades it identically.
    const venuesAsOf = venues?.fetchedAt ?? null;
    if (venues !== null) {
        log(`read ${venuesByMint.size} venue record(s) from ${venuesPath} (fetched ${venuesAsOf ?? 'unknown'})`);
        if (venuesAsOf === null) logWarn(`${venuesPath} carries no fetchedAt — no CEX price can be shown to be fresh, so cross-venue spreads fall back to DEX pools only`);
    }
    if (holders !== null) {
        const measurable = holders.items.filter((i) => Number.isFinite(i?.top1SharePct)).length;
        log(`read ${holdersByMint.size} holder record(s) from ${holdersPath} (fetched ${holdersAsOf ?? 'unknown'}), ${measurable} with a measurable share`);
    }
    const sponsors = indexSponsors(sponsorApis.items);

    const universeItems = [...universe.items].sort((a, b) => byString(a.mint, b.mint));
    const tokens = universeItems.map((item) => buildToken(
        item, onchainByMint.get(item.mint) ?? null, referenceByMint.get(item.mint) ?? null, sponsors,
        venuesByMint.get(item.mint) ?? null, venuesAsOf,
        holdersByMint.get(item.mint) ?? null, holdersAsOf
    ));

    const missingVenues = venues === null ? [] : tokens.filter((t) => !venuesByMint.has(t.mint));
    if (missingVenues.length) logWarn(`${missingVenues.length} token(s) are in the universe but not in ${venuesPath}, so their venue fields are null: ${missingVenues.slice(0, 5).map((t) => t.symbol ?? t.mint).join(', ')}${missingVenues.length > 5 ? ' …' : ''}`);

    const missingHolders = holders === null ? [] : tokens.filter((t) => !holdersByMint.has(t.mint));
    if (missingHolders.length) logWarn(`${missingHolders.length} token(s) are in the universe but not in ${holdersPath}, so their holders block is null: ${missingHolders.slice(0, 5).map((t) => t.symbol ?? t.mint).join(', ')}${missingHolders.length > 5 ? ' …' : ''}`);

    const missingOnchain = tokens.filter((t) => !onchainByMint.has(t.mint));
    const missingReference = tokens.filter((t) => t.reference.source === null);
    const missingIssuerApi = tokens.filter((t) => t.issuerApi === null && t.issuer === 'ondo-global-markets');
    if (missingOnchain.length) logWarn(`${missingOnchain.length} token(s) have no on-chain record, so their control flags are null: ${missingOnchain.slice(0, 5).map((t) => t.symbol ?? t.mint).join(', ')}${missingOnchain.length > 5 ? ' …' : ''}`);
    if (missingReference.length) logWarn(`${missingReference.length} token(s) have no independent reference price source, so their premium is null`);
    if (missingIssuerApi.length) logWarn(`${missingIssuerApi.length} Ondo token(s) did not match an API item on ticker === underlyingTicker: ${missingIssuerApi.slice(0, 5).map((t) => t.symbol ?? t.mint).join(', ')}${missingIssuerApi.length > 5 ? ' …' : ''}`);

    const tokensByIssuer = new Map();
    for (const token of tokens) {
        if (!token.issuer) continue;
        if (!tokensByIssuer.has(token.issuer)) tokensByIssuer.set(token.issuer, []);
        tokensByIssuer.get(token.issuer).push(token);
    }
    const unclaimed = tokens.filter((t) => !t.issuer).length;
    if (unclaimed) logWarn(`${unclaimed} token(s) carry no issuer and belong to no issuer record`);

    const dossierSlugs = new Set(dossiers.map((d) => d.slug));
    for (const [slug, list] of tokensByIssuer) {
        if (!dossierSlugs.has(slug)) {
            logWarn(`issuer "${slug}" holds ${list.length} token(s) but has no dossier in ${issuersDir} — it gets no issuer record`);
        }
    }

    const issuers = dossiers.map(({ slug, file, dossier }) => {
        if (typeof dossier.status !== 'string' || dossier.status.trim() === '') {
            logWarn(`dossier ${file} has no "status" — defaulting to "${statusOf(slug, dossier)}" (MODEL.md §2.6)`);
        }
        if (!Array.isArray(dossier.findings)) logWarn(`dossier ${file} has no "findings" — defaulting to []`);
        if (!dossier.keyGovernance) logWarn(`dossier ${file} has no "keyGovernance" — defaulting to all "unknown"`);
        const verification = verificationStrength(dossier);
        if (verification.strength === null) {
            logWarn(`dossier ${file} has custodyVerification.type "${verification.type}", which is not one of ${Object.keys(VERIFICATION_STRENGTH).join(' | ')} — verification strength is null`);
        }

        const issuerTokens = tokensByIssuer.get(slug) ?? [];
        const onchainItems = issuerTokens.map((t) => onchainByMint.get(t.mint)).filter(Boolean);
        const venuesItems = issuerTokens.map((t) => venuesByMint.get(t.mint)).filter(Boolean);
        return buildIssuer({ slug, dossier }, issuerTokens, onchainItems, referenceByMint, venuesItems);
    });

    // One timestamp and one sources envelope, shared by both files, so a page that has loaded the
    // issuers and is still waiting for the tokens can never show two different "as of" readings.
    const builtAt = ts();
    const sources = {
        universe: { file: 'stocks/data/universe.json', fetchedAt: universe.fetchedAt ?? null, tokens: universe.items.length },
        onchain: { file: 'stocks/data/onchain.json', fetchedAt: onchain.fetchedAt ?? null, mints: onchain.items.length },
        sponsorApis: { file: 'stocks/data/sponsor-apis.json', fetchedAt: sponsorApis.fetchedAt ?? null },
        referencePrices: { file: 'stocks/data/reference-prices.json', fetchedAt: referencePrices.fetchedAt ?? null },
        venues: venues === null
            ? null
            : { file: 'stocks/data/venues.json', fetchedAt: venuesAsOf, tokens: venuesByMint.size },
        holders: holders === null
            ? null
            : { file: 'stocks/data/holders.json', fetchedAt: holdersAsOf, supplyFetchedAt: holders.source?.supplyFetchedAt ?? null, tokens: holdersByMint.size },
        issuers: issuers.map((i) => i.slug)
    };

    const issuersPath = await writeJson(join(outDir, ISSUERS_FILE), { builtAt, sources, issuers });
    // One-space indent for the token file only: MODEL.md §10.1 splits it off precisely to keep the
    // page's second load under a megabyte, and the §11.2 activity block costs ~170 kB of that
    // budget. Dropping one space per level buys ~130 kB and loses nothing — same fields, same
    // values, still one key per line and still diffable.
    const tokensPath = await writeJson(join(outDir, TOKENS_FILE), {
        builtAt,
        sources,
        issuerIndex: issuers.map(issuerIndexEntry),
        tokens
    }, 1);
    // The third, tiny file: the four-column funnel the stocks page draws above the grid. It is
    // written here rather than counted in the browser so the graphic shows the build's own numbers
    // and a test can pin them (stocks/funnel.test.js, stocks-page.test.js).
    const funnel = buildFunnel(tokens, issuers);
    const funnelPath = await writeJson(join(outDir, FUNNEL_FILE), { builtAt, ...funnel });

    log(`wrote ${issuersPath}: ${issuers.length} issuer(s), ${await kb(issuersPath)}`);
    log(`wrote ${tokensPath}: ${tokens.length} token(s) + ${issuers.length} index entry(ies), ${await kb(tokensPath)}`);
    log(`wrote ${funnelPath}: ${funnel.columns.map((c) => `${c.nodes.length} ${c.key}`).join(' -> ')}, ${funnel.edges.length} edge(s), ${await kb(funnelPath)}`);

    const unprofiled = tokens.filter((t) => t.recipe.label === 'unknown');
    log(`control recipes (${funnel.columns[2].nodes.length} distinct across ${tokens.length} mints):`);
    for (const node of funnel.columns[2].nodes) {
        log(`  ${String(node.count).padStart(4)}  ${node.label}`);
    }
    if (unprofiled.length) {
        logWarn(`${unprofiled.length} mint(s) have no control recipe because they have no on-chain row — run npm run stocks:onchain: ${unprofiled.slice(0, 5).map((t) => t.symbol ?? t.mint).join(', ')}${unprofiled.length > 5 ? ' …' : ''}`);
    }

    log('per-issuer grades and market reality:');
    for (const issuer of issuers) log(`  ${summariseIssuer(issuer)}`);

    // Evidence coverage per issuer (stocks/EVIDENCE.md §4): claims loaded, and how many of the
    // fields that need a source have a CONFIRMED one. An unverified or inferred claim is a claim
    // but not a source, so it is counted separately and never folded into `sourced`.
    const ev = issuers.map((i) => i.evidence);
    log(`evidence: ${sumFinite(ev.map((e) => e.claims)) ?? 0} claim(s) across ${issuers.length} issuer(s), `
        + `${sumFinite(ev.map((e) => e.coverage.sourced)) ?? 0}/${sumFinite(ev.map((e) => e.coverage.needed)) ?? 0} field(s) sourced `
        + `(${CLAIM_FIELDS.length} need-patterns in stocks/data/claim-fields.json)`);
    for (const issuer of issuers) {
        const e = issuer.evidence;
        log(`  ${issuer.slug.padEnd(24)} ${String(e.coverage.sourced).padStart(3)}/${String(e.coverage.needed).padEnd(3)} sourced`
            + ` · ${String(e.claims).padStart(3)} claim(s)`
            + ` · confirmed ${e.confirmed} unverified ${e.unverified} inference ${e.inference} corrected ${e.corrected}`
            + ` · last checked ${e.lastCheckedAt ?? 'never'}`);
    }

    log('per-issuer trading activity (MODEL.md §11.3 — traders24 is a Σ, wallets may overlap across tokens):');
    for (const issuer of issuers) log(`  ${summariseActivity(issuer)}`);

    const spreads = tokens.filter((t) => Number.isFinite(t.activity.venueSpreadPct));
    const byRatio = tokens
        .filter((t) => Number.isFinite(t.activity.tradesPerTrader))
        .sort((a, b) => b.activity.tradesPerTrader - a.activity.tradesPerTrader);
    log(`activity coverage: ${tokens.filter((t) => Number.isFinite(t.activity.trades24)).length}/${tokens.length} token(s) report trade counts, ${tokens.filter((t) => Number.isFinite(t.activity.dexTxns24)).length} report DEX txns, ${spreads.length} have a cross-venue spread (median ${pct(median(spreads.map((t) => t.activity.venueSpreadPct)), 2)}, max ${pct(Math.max(0, ...spreads.map((t) => t.activity.venueSpreadPct)), 2)})`);
    if (byRatio.length) {
        log('highest trades per trader (the wash-trading tell, MODEL.md §11.1):');
        for (const token of byRatio.slice(0, 5)) {
            const a = token.activity;
            log(`  ${(token.symbol ?? token.mint).padEnd(10)} ${num(a.tradesPerTrader, 1).padStart(8)} trades/trader  (${num(a.trades24)} trades, ${num(a.traders24)} traders, liquidity ${usd(token.market.liquidity)}, ${token.issuer})`);
        }
    }

    const live = issuers.filter((i) => i.status === 'live');
    const liveTokenCount = live.reduce((total, i) => total + i.tokenMints.length, 0);
    log(`live issuers: ${live.length}/${issuers.length}, ${liveTokenCount} token(s), liquidity ${usd(sumFinite(live.map((i) => i.market.dexLiquidityUsd)))}, 24 h volume ${usd(sumFinite(live.map((i) => i.market.vol24Usd)))}, holders ${sumFinite(live.map((i) => i.market.holdersSum)) ?? 'n/a'}`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
