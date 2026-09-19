#!/usr/bin/env node
// Builds the reusable technology/legal-template data and static pages from the issuer dossiers,
// observed token recipes and the reviewed composability registry. No legal conclusion is fetched.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildLegalTemplates } from './lib/legal-templates.mjs';
import { renderTemplateIndex, renderTemplatePage } from './lib/template-pages.mjs';
import { log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const ISSUERS_PATH = join(ROOT, 'stocks-issuers.json');
const TOKENS_PATH = join(ROOT, 'stocks-tokens.json');
const COMPOSABILITY_PATH = join(HERE, 'data', 'composability-templates.json');
const SOURCES_STATE_PATH = join(HERE, 'data', 'sources-state.json');
const OUTPUT_PATH = join(ROOT, 'stocks-legal-templates.json');
const DEFAULT_OUT_DIR = 'templates';
const ASSET_VERSION = '20260920a';

function usage() {
    console.log(`build-legal-templates.mjs — reusable legal architectures and static pages

USAGE
  node stocks/build-legal-templates.mjs --run [options]

OPTIONS
  --run                     Build the data and pages. Without it, print this help only.
  --base-url=<origin>       Optional canonical origin, e.g. https://rwasonar.com.
  --out-dir=<dir>           Page directory (default ${DEFAULT_OUT_DIR}/ relative to repo root).
  --help                    Print this help.

INPUTS
  stocks-issuers.json, stocks-tokens.json, stocks/data/composability-templates.json,
  stocks/data/sources-state.json (optional archive links)

OUTPUTS
  stocks-legal-templates.json
  <out-dir>/index.html
  <out-dir>/<template-id>.html and .json`);
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
    if (baseUrl === null) logWarn('no --base-url: canonical links are omitted');

    const issuerDb = await readJson(ISSUERS_PATH);
    const tokenDb = await readJson(TOKENS_PATH);
    const composability = await readJson(COMPOSABILITY_PATH);
    const sourceState = await readJson(SOURCES_STATE_PATH, {});
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
        archives: sourceState
    });
    if (templates.length !== reviewed.length) {
        throw new Error(`built ${templates.length}/${reviewed.length} templates; an issuer/template mapping is missing`);
    }

    const builtAt = ts();
    const output = {
        builtAt,
        reviewedAt: composability.reviewedAt ?? null,
        methodology: 'One conclusion is inherited only by exact issuer-programme plus observed control-recipe matches. Asset-specific exceptions override the template only when explicitly recorded.',
        precedence: templates[0]?.sourceAuthority?.precedence ?? [],
        templates
    };
    await writeJson(OUTPUT_PATH, output);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'index.html'), renderTemplateIndex(templates, { baseUrl, version: ASSET_VERSION }), 'utf8');
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
        await writeFile(join(outDir, htmlName), renderTemplatePage(template, { baseUrl, version: ASSET_VERSION }), 'utf8');
        await writeJson(join(outDir, jsonName), template, 0);
    }
    const pruned = await prune(outDir, keep);
    const assets = templates.reduce((sum, template) => sum + template.inheritance.count, 0);
    log(`wrote ${templates.length} legal template(s) covering ${assets} exact issuer/recipe token match(es)` +
        `${pruned ? `; pruned ${pruned} stale page(s)` : ''}`);
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
