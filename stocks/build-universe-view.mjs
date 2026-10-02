#!/usr/bin/env node
// Writes universe-view/index.json for the universe view (universe.html): the tokens, the values they
// share and the links between them, as tables the view can group on any attribute. A local
// derivation of files the release already builds (the token cards among them); it collects nothing.
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { log, logError, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { buildUniverseIndex } from './lib/universe-view.mjs';

const ROOT = join(import.meta.dirname, '..');

function usage() {
    console.log(`build-universe-view.mjs — the universe view's tables

USAGE
  node stocks/build-universe-view.mjs --run [--out=universe-view/index.json]

INPUTS
  stocks-tokens.json, stocks-issuers.json, stocks-power-map.json, stocks/data/holder-rights.json,
  stocks/data/composability-templates.json, cards/index.json and every cards/<slug>.json
  (run stocks/build-cards.mjs first)

OUTPUT
  {generatedAt, catalogueBuiltAt, tables: {tokens, values, tokenValues, attributes, dimensions}
  (each {columns, rows}), issuers[…], scenarios, templates, ruleLabels}`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const out = resolve(ROOT, typeof flags.out === 'string' ? flags.out : 'universe-view/index.json');
    const [tokensDoc, issuersDoc, rightsDoc, templatesDoc, powerMap, cardIndex] = await Promise.all([
        readJson(join(ROOT, 'stocks-tokens.json')),
        readJson(join(ROOT, 'stocks-issuers.json')),
        readJson(join(ROOT, 'stocks/data/holder-rights.json'), null),
        readJson(join(ROOT, 'stocks/data/composability-templates.json'), null),
        readJson(join(ROOT, 'stocks-power-map.json'), null),
        readJson(join(ROOT, 'cards/index.json'))
    ]);
    if (!powerMap) log('stocks-power-map.json not built: key moons are labelled by kind only, without signer thresholds');
    const cards = new Map();
    for (let i = 0; i < cardIndex.length; i += 1) {
        const slug = cardIndex[i].slug;
        cards.set(slug, await readJson(join(ROOT, 'cards', `${slug}.json`)));
        if ((i + 1) % 250 === 0 || i + 1 === cardIndex.length) log(`read ${i + 1}/${cardIndex.length} cards`);
    }
    const index = buildUniverseIndex({ tokensDoc, issuersDoc, rightsDoc, templatesDoc, powerMap, cardIndex, cards, generatedAt: ts() });
    await mkdir(dirname(out), { recursive: true });
    await writeJson(out, index, 0);
    const t = index.tables;
    log(`wrote ${out}: ${t.tokens.rows.length} tokens, ${t.values.rows.length} shared values, ${t.tokenValues.rows.length} links, ${t.attributes.rows.length} attributes`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
