#!/usr/bin/env node
// Joins the four machine-collected data files (universe, on-chain mint state, sponsor APIs,
// reference prices) with the hand-researched issuer dossiers and writes the repo-root
// stocks-db.json that the stocks page reads — one record per issuer with its grades, control
// surface and market reality, and one record per mint. Every rule it applies lives in
// lib/grade.mjs; this file only reads, joins, sorts and reports. MODEL.md §7 is the schema.

import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import {
    byString, log, logError, logWarn, parseArgs, readJson, ts, writeJson
} from './lib/io.mjs';
import {
    VERIFICATION_STRENGTH, claimRung, controlSurface, instrumentType, marketReality, maturityScore,
    maturityStage, maturityStageNum, supplyUi, verificationStrength
} from './lib/grade.mjs';

import { issuerLabel } from './lib/classify.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const DATA_DIR = join(HERE, 'data');
const DEFAULT_OUT = join(REPO_ROOT, 'stocks-db.json');

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

const UNKNOWN_KEY_GOVERNANCE = { mint: 'unknown', freeze: 'unknown', delegate: 'unknown', evidence: null };
const FREEZE_EXERCISED_FINDING = 'freeze-authority-has-been-exercised';

function usage() {
    console.log(`build-stocks-db.mjs — join the stocks data files into the repo-root stocks-db.json

USAGE
  node stocks/build-stocks-db.mjs --run [options]

OPTIONS
  --run          Actually build. Without it this help is printed and nothing runs.
  --out=<path>   Output file (default ${DEFAULT_OUT}).
  --data=<dir>   Directory holding universe/onchain/sponsor-apis/reference-prices.json
                 and issuers/ (default ${DATA_DIR}).
  --help         This text.

INPUTS
  data/universe.json          one record per mint, from Jupiter (npm run stocks:universe)
  data/onchain.json           Token-2022 mint state per mint (npm run stocks:onchain)
  data/sponsor-apis.json      issuer-run APIs, keyed by sponsor (npm run stocks:sponsors)
  data/reference-prices.json  independent reference price and premium (npm run stocks:prices)
  data/issuers/<slug>.json    the hand-researched dossiers

NOTES
  Tokens are joined by mint; Ondo's API items are joined on ticker === underlyingTicker and only
  for Ondo tokens. Issuers are sorted by slug and tokens by mint, so a rebuild with unchanged
  inputs produces an unchanged file. Headline totals cover live issuers only; a defunct issuer is
  still written out, with whatever mints the universe still holds. Nothing is written until every
  input has been read, so a missing fetcher output fails the run instead of truncating the DB.`);
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

function buildToken(universeItem, onchain, reference, sponsors) {
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

    return {
        mint: universeItem.mint,
        symbol: universeItem.symbol ?? null,
        name: universeItem.name ?? null,
        issuer: universeItem.issuer ?? null,
        underlyingTicker: universeItem.underlyingTicker ?? null,
        instrumentType: instrumentType(universeItem, issuerApi),
        listedOnJupiter: universeItem.listedOnJupiter === true,
        decimals,
        supplyRaw,
        uiMultiplier,
        supplyUi: supplyUi(supplyRaw, decimals, uiMultiplier),
        tokenProgram: onchain?.tokenProgram ?? universeItem.tokenProgram ?? null,
        metadataUri: onchain?.metadataUri ?? null,
        control: {
            clawback: onchain ? onchain.permanentDelegate === true : null,
            freezeAuthority: onchain?.freezeAuthority ?? null,
            pausable: onchain ? onchain.pausable === true : null,
            paused: typeof onchain?.paused === 'boolean' ? onchain.paused : null,
            allowlist: onchain ? onchain.defaultAccountStateFrozen === true : null,
            transferFeeBps: finiteOrNull(onchain?.transferFeeBps),
            hookActive: onchain ? typeof onchain.transferHookProgram === 'string' : null
        },
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

function buildIssuer({ slug, dossier }, tokens, onchainItems, prices) {
    const findings = Array.isArray(dossier.findings) ? dossier.findings : [];
    const keyGovernance = dossier.keyGovernance ?? { ...UNKNOWN_KEY_GOVERNANCE };
    const claim = claimRung(dossier);
    const verification = verificationStrength(dossier);

    return {
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
        market: marketReality(tokens, prices),
        tokenMints: tokens.map((t) => t.mint)
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
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const issuersDir = join(dataDir, 'issuers');

    const universe = await readInput(join(dataDir, 'universe.json'), 'npm run stocks:universe');
    const onchain = await readInput(join(dataDir, 'onchain.json'), 'npm run stocks:onchain');
    const sponsorApis = await readInput(join(dataDir, 'sponsor-apis.json'), 'npm run stocks:sponsors');
    const referencePrices = await readInput(join(dataDir, 'reference-prices.json'), 'npm run stocks:prices');
    const dossiers = await readDossiers(issuersDir);
    log(`read ${universe.items.length} universe token(s), ${onchain.items.length} on-chain mint(s), ${referencePrices.items.length} reference price(s), ${dossiers.length} dossier(s)`);

    const onchainByMint = indexByMint(onchain.items);
    const referenceByMint = indexByMint(referencePrices.items);
    const sponsors = indexSponsors(sponsorApis.items);

    const universeItems = [...universe.items].sort((a, b) => byString(a.mint, b.mint));
    const tokens = universeItems.map((item) => buildToken(
        item, onchainByMint.get(item.mint) ?? null, referenceByMint.get(item.mint) ?? null, sponsors
    ));

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
        return buildIssuer({ slug, dossier }, issuerTokens, onchainItems, referenceByMint);
    });

    await writeJson(outPath, {
        builtAt: ts(),
        sources: {
            universe: { file: 'stocks/data/universe.json', fetchedAt: universe.fetchedAt ?? null, tokens: universe.items.length },
            onchain: { file: 'stocks/data/onchain.json', fetchedAt: onchain.fetchedAt ?? null, mints: onchain.items.length },
            sponsorApis: { file: 'stocks/data/sponsor-apis.json', fetchedAt: sponsorApis.fetchedAt ?? null },
            referencePrices: { file: 'stocks/data/reference-prices.json', fetchedAt: referencePrices.fetchedAt ?? null },
            issuers: issuers.map((i) => i.slug)
        },
        issuers,
        tokens
    });
    log(`wrote ${outPath}: ${issuers.length} issuer(s), ${tokens.length} token(s)`);

    log('per-issuer grades and market reality:');
    for (const issuer of issuers) log(`  ${summariseIssuer(issuer)}`);

    const live = issuers.filter((i) => i.status === 'live');
    const liveTokenCount = live.reduce((total, i) => total + i.tokenMints.length, 0);
    log(`live issuers: ${live.length}/${issuers.length}, ${liveTokenCount} token(s), liquidity ${usd(sumFinite(live.map((i) => i.market.dexLiquidityUsd)))}, 24 h volume ${usd(sumFinite(live.map((i) => i.market.vol24Usd)))}, holders ${sumFinite(live.map((i) => i.market.holdersSum)) ?? 'n/a'}`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
