#!/usr/bin/env node
// Builds the reader-facing change journal from public actor-change resolutions, curated incidents
// and named catalogue additions/removals. Internal research corrections never enter this artifact.

import { join } from 'node:path';
import { assignSlugs } from './lib/cards.mjs';
import { buildChangeJournal } from './lib/change-journal.mjs';
import { log, logError, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const ROOT = join(import.meta.dirname, '..');

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run) {
        console.log('Usage: node stocks/build-change-journal.mjs --run [--out=stocks-change-journal.json]');
        return;
    }
    const [changes, events, resolutions, identities, tokenDb] = await Promise.all([
        readJson(join(ROOT, 'stocks-changes.json'), {}),
        readJson(join(ROOT, 'stocks/data/events.json'), {}),
        readJson(join(ROOT, 'stocks/data/event-resolutions.json'), {}),
        readJson(join(ROOT, 'stocks/data/mint-identities.json'), {}),
        readJson(join(ROOT, 'stocks-tokens.json'), {})
    ]);
    const tokens = Array.isArray(tokenDb.tokens) ? tokenDb.tokens : [];
    const slugs = assignSlugs(tokens);
    const tokenRows = tokens.map((token) => ({ ...token, cardSlug: slugs.get(token.mint) ?? null }));
    const items = buildChangeJournal({
        changes: changes.assetChanges,
        curatedEvents: events.events,
        resolutions: resolutions.items,
        identities: identities.items,
        tokens: tokenRows,
        issuerNames: Object.fromEntries((Array.isArray(tokenDb.issuerIndex) ? tokenDb.issuerIndex : [])
            .filter((issuer) => issuer?.slug && issuer?.name)
            .map((issuer) => [issuer.slug, issuer.name]))
    });
    const out = typeof flags.out === 'string' ? flags.out : join(ROOT, 'stocks-change-journal.json');
    await writeJson(out, {
        generatedAt: ts(),
        methodology: 'Real issuer, venue, protocol and source changes plus observed catalogue membership changes. RWA Sonar editorial corrections and transient watcher failures are excluded.',
        items
    });
    log(`change journal: ${items.length} public item(s) (${items.filter((item) => item.category === 'catalogue').length} catalogue)`);
}

main().catch((error) => {
    logError(error.stack ?? String(error));
    process.exitCode = 1;
});
