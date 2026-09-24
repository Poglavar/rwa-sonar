#!/usr/bin/env node
// Builds the reusable technology/legal-template data and static pages from the issuer dossiers,
// observed token recipes and the reviewed composability registry. No legal conclusion is fetched.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildLegalTemplates } from './lib/legal-templates.mjs';
import { renderTemplateIndex, renderTemplatePage } from './lib/template-pages.mjs';
import { renderIssuerIndex, renderIssuerPage } from './lib/issuer-pages.mjs';
import { assignSlugs } from './lib/cards.mjs';
import { readWhatIf } from './lib/issuer-whatif.mjs';
import { loadSchematics } from './lib/schematics-load.mjs';
import { TRUST_CHAIN } from './lib/trustchain.mjs';
import { log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { absoluteImage, familyOgImage, finishFamilyOg, prepareFamilyOg } from './lib/og-family.mjs';
import { fmtCount, issuerOgModel, pageOgModel, templateOgModel } from './lib/page-og.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const ISSUERS_PATH = join(ROOT, 'stocks-issuers.json');
const TOKENS_PATH = join(ROOT, 'stocks-tokens.json');
const COMPOSABILITY_PATH = join(HERE, 'data', 'composability-templates.json');
const SOURCES_STATE_PATH = join(HERE, 'data', 'sources-state.json');
const ISSUER_DOSSIER_DIR = join(HERE, 'data', 'issuers');
const OUTPUT_PATH = join(ROOT, 'stocks-legal-templates.json');
const REVIEW_QUEUE_PATH = join(ROOT, 'stocks-review-queue.json');
const POWER_MAP_PATH = join(ROOT, 'stocks-power-map.json');
const DEFAULT_OUT_DIR = 'templates';
const DEFAULT_ISSUER_OUT_DIR = 'issuers';
const ASSET_VERSION = '20260924u';

function usage() {
    console.log(`build-legal-templates.mjs — reusable legal architectures and static pages

USAGE
  node stocks/build-legal-templates.mjs --run [options]

OPTIONS
  --run                     Build the data and pages. Without it, print this help only.
  --base-url=<origin>       Optional canonical origin, e.g. https://rwasonar.com.
  --out-dir=<dir>           Page directory (default ${DEFAULT_OUT_DIR}/ relative to repo root).
  --issuer-out-dir=<dir>    Issuer dossier directory (default ${DEFAULT_ISSUER_OUT_DIR}/).
  --no-og-images            Keep the site preview image on every template and issuer page.
  --help                    Print this help.

INPUTS
  stocks-issuers.json, stocks-tokens.json, stocks/data/composability-templates.json,
  stocks/data/sources-state.json (optional archive links),
  stocks/data/issuers/*.json (the what-if answers counted on each issuer dossier)
  stocks-power-map.json (optional: who holds the mint/freeze keys, drawn on each issuer's image)

OUTPUTS
  stocks-legal-templates.json
  <out-dir>/index.html
  <out-dir>/<template-id>.html and .json
  <out-dir>/og/, <issuer-out-dir>/og/   1200×630 preview per page, content-hashed, re-rendered only on change
                            (needs \`npm ci --prefix stocks/og\`; without it every page keeps the site image)`);
}

async function prune(dir, keep) {
    let files = [];
    try {
        files = await readdir(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return 0;
        throw err;
    }
    let removed = 0;
    for (const file of files) {
        if (!/\.(html|json)$/.test(file) || keep.has(file)) continue;
        await rm(join(dir, file));
        removed += 1;
    }
    return removed;
}

export async function main(argv = process.argv.slice(2)) {
    const { flags } = parseArgs(argv);
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const baseUrl = typeof flags['base-url'] === 'string' ? flags['base-url'] : null;
    const outDir = resolve(ROOT, typeof flags['out-dir'] === 'string' ? flags['out-dir'] : DEFAULT_OUT_DIR);
    const issuerOutDir = resolve(ROOT, typeof flags['issuer-out-dir'] === 'string' ? flags['issuer-out-dir'] : DEFAULT_ISSUER_OUT_DIR);
    if (baseUrl === null) logWarn('no --base-url: canonical links are omitted');

    const issuerDb = await readJson(ISSUERS_PATH);
    const tokenDb = await readJson(TOKENS_PATH);
    const composability = await readJson(COMPOSABILITY_PATH);
    const sourceState = await readJson(SOURCES_STATE_PATH, {});
    const reviewQueue = await readJson(REVIEW_QUEUE_PATH, { items: [] });
    if (!Array.isArray(issuerDb?.issuers)) throw new Error(`${ISSUERS_PATH}: expected issuers[]`);
    if (!Array.isArray(tokenDb?.tokens)) throw new Error(`${TOKENS_PATH}: expected tokens[]`);
    if (!Array.isArray(composability?.templates)) throw new Error(`${COMPOSABILITY_PATH}: expected templates[]`);

    const reviewed = composability.templates.map((template) => ({
        ...template,
        reviewedAt: template.reviewedAt ?? composability.reviewedAt ?? null
    }));
    const templates = buildLegalTemplates({
        templates: reviewed,
        issuers: issuerDb.issuers,
        tokens: tokenDb.tokens,
        archives: sourceState,
        reviewItems: reviewQueue.items ?? []
    });
    if (templates.length !== reviewed.length) {
        throw new Error(`built ${templates.length}/${reviewed.length} templates; an issuer/template mapping is missing`);
    }

    const builtAt = ts();
    const cardSlugs = assignSlugs(tokenDb.tokens);
    const output = {
        builtAt,
        reviewedAt: composability.reviewedAt ?? null,
        methodology: 'One conclusion is inherited only by exact issuer-programme plus observed control-recipe matches. Asset-specific exceptions override the template only when explicitly recorded.',
        precedence: templates[0]?.sourceAuthority?.precedence ?? [],
        templates
    };
    await writeJson(OUTPUT_PATH, output);
    await mkdir(outDir, { recursive: true });
    await mkdir(issuerOutDir, { recursive: true });
    const origin = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, '') : null;
    const images = flags['no-og-images'] !== true && origin !== null;
    const templateOg = await prepareFamilyOg({ outDir, urlPrefix: 'templates', label: 'template', enabled: images });
    const issuerOg = await prepareFamilyOg({ outDir: issuerOutDir, urlPrefix: 'issuers', label: 'issuer', enabled: images });
    const imageFor = async (state, slug, model) => absoluteImage(origin, await familyOgImage(state, slug, model));
    const covered = templates.reduce((sum, template) => sum + (template.inheritance?.count ?? 0), 0);
    await writeFile(join(outDir, 'index.html'), renderTemplateIndex(templates, {
        baseUrl, version: ASSET_VERSION,
        ogImage: await imageFor(templateOg, 'index', pageOgModel({
            kicker: 'Legal + control templates', title: 'Technology + legal templates',
            subtitle: 'A token inherits an analysis only when its issuer programme and observed control recipe both match.',
            stats: [{ value: fmtCount(templates.length), label: 'reviewed templates' },
                { value: fmtCount(covered), label: 'exact tokens covered' },
                { value: fmtCount(new Set(templates.map((t) => t.issuer?.slug)).size), label: 'issuer programmes' }],
            path: 'templates/'
        }))
    }), 'utf8');
    await writeJson(join(outDir, 'index.json'), templates.map((template) => ({
        id: template.id,
        issuer: template.issuer,
        legalTemplate: template.legalTemplate,
        technologyRecipe: template.technologyRecipe,
        assetCount: template.inheritance.count,
        underlyingCount: template.inheritance.underlyingCount,
        reviewedAt: template.reviewedAt
    })), 0);
    const keep = new Set(['index.html', 'index.json']);
    for (const template of templates) {
        const htmlName = `${template.id}.html`;
        const jsonName = `${template.id}.json`;
        keep.add(htmlName);
        keep.add(jsonName);
        const ogImage = await imageFor(templateOg, template.id, templateOgModel(template));
        await writeFile(join(outDir, htmlName), renderTemplatePage(template, { baseUrl, version: ASSET_VERSION, cardSlugs, ogImage }), 'utf8');
        await writeJson(join(outDir, jsonName), template, 0);
    }
    const pruned = await prune(outDir, keep);
    const powerMap = await readJson(POWER_MAP_PATH, null);
    const powerRows = new Map((powerMap?.issuers ?? []).map((row) => [row.slug, row]));
    const live = issuerDb.issuers.filter((issuer) => issuer.status === 'live').length;
    await writeFile(join(issuerOutDir, 'index.html'), renderIssuerIndex(issuerDb.issuers, {
        baseUrl, version: ASSET_VERSION,
        ogImage: await imageFor(issuerOg, 'index', pageOgModel({
            kicker: 'Issuer dossiers', title: 'Who stands behind the token?',
            subtitle: 'One dossier per issuer programme: holder claim, redemption, controls, evidence and exact Solana assets.',
            stats: [{ value: fmtCount(issuerDb.issuers.length), label: 'issuer programmes' },
                { value: fmtCount(live), label: 'live programmes' },
                { value: fmtCount(tokenDb.tokens.length), label: 'exact Solana tokens' }],
            path: 'issuers/'
        }))
    }), 'utf8');
    const issuerKeep = new Set(['index.html']);
    const whatIfBySlug = await readWhatIf(ISSUER_DOSSIER_DIR, issuerDb.issuers.map((issuer) => issuer.slug));
    const schematics = await loadSchematics({ issuers: issuerDb.issuers });
    for (const issuer of issuerDb.issuers) {
        const name = `${issuer.slug}.html`;
        issuerKeep.add(name);
        const issuerTokens = tokenDb.tokens.filter((token) => token.issuer === issuer.slug);
        const ogImage = await imageFor(issuerOg, issuer.slug, issuerOgModel({
            issuer, tokenCount: issuerTokens.length, powerRow: powerRows.get(issuer.slug) ?? null,
            questionCount: TRUST_CHAIN.failureModes.length
        }));
        await writeFile(join(issuerOutDir, name), renderIssuerPage({
            issuer,
            tokens: issuerTokens,
            templates,
            builtAt: issuerDb.builtAt,
            whatIf: whatIfBySlug.get(issuer.slug) ?? null,
            whatIfQuestions: TRUST_CHAIN.failureModes.length,
            schematics: schematics.issuers[issuer.slug] ?? null
        }, { baseUrl, version: ASSET_VERSION, cardSlugs, ogImage }), 'utf8');
    }
    await finishFamilyOg(templateOg);
    await finishFamilyOg(issuerOg);
    const prunedIssuers = await prune(issuerOutDir, issuerKeep);
    const assets = templates.reduce((sum, template) => sum + template.inheritance.count, 0);
    log(`wrote ${templates.length} legal template(s) covering ${assets} exact issuer/recipe token match(es)` +
        ` and ${issuerDb.issuers.length} canonical issuer dossier(s)` +
        `${pruned || prunedIssuers ? `; pruned ${pruned + prunedIssuers} stale page(s)` : ''}`);
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
