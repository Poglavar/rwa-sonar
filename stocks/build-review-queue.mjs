#!/usr/bin/env node
// Build the public evidence-review inbox from required dossier fields, current watcher claim
// states, unacknowledged change events and DeFi-enforcement questions in the legal templates.

import { join } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { log, logError, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { psql } from './lib/psql.mjs';
import { buildReviewQueue, queueSummary } from './lib/review-queue.mjs';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'stocks-review-queue.json');

async function rows(databaseUrl, sql, label) {
    const out = await psql(databaseUrl, `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)::text FROM (${sql}) q;`, label, ['-t', '-A']);
    return JSON.parse(out.trim() || '[]');
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run) {
        console.log('Usage: node stocks/build-review-queue.mjs --run');
        return;
    }
    const env = { ...(await readEnvFile(join(ROOT, '.env'))), ...process.env };
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is missing from .env');
    const [issuerDb, legalTemplates, databaseClaims, changeEvents] = await Promise.all([
        readJson(join(ROOT, 'stocks-issuers.json')),
        readJson(join(ROOT, 'stocks-legal-templates.json')),
        rows(env.DATABASE_URL, `
            SELECT issuer_slug, field, status, url, accessed_at, last_checked_at, last_confirmed_at
            FROM sonar.claim`, 'review queue claims'),
        rows(env.DATABASE_URL, `
            SELECT e.id, e.detected_at, e.kind, e.subject_type, e.subject_id, e.field,
                   e.severity, e.summary, e.acknowledged_at,
                   COALESCE(c.issuer_slug, s.issuer_slug, t.issuer_slug,
                            CASE WHEN e.subject_type = 'issuer' THEN e.subject_id END) AS issuer_slug
            FROM sonar.change_event e
            LEFT JOIN sonar.claim c ON e.subject_type = 'issuer' AND c.issuer_slug = e.subject_id AND c.field = e.field
            LEFT JOIN sonar.source s ON e.subject_type = 'source' AND s.id = e.subject_id
            LEFT JOIN sonar.stock_token t ON e.subject_type = 'token' AND t.mint = e.subject_id
            WHERE e.acknowledged_at IS NULL
              AND e.kind IN ('legal-term', 'document-gone', 'authority-key', 'extension-toggle', 'metadata', 'status')
            GROUP BY e.id, c.issuer_slug, s.issuer_slug, t.issuer_slug
            ORDER BY e.detected_at DESC`, 'review queue events')
    ]);
    const generatedAt = ts();
    const items = buildReviewQueue({ issuerDb, legalTemplates, databaseClaims, changeEvents, nowMs: Date.parse(generatedAt) });
    const artifact = { generatedAt, methodology: 'required fields + watcher state + unacknowledged consequential events', summary: queueSummary(items), items };
    await writeJson(OUT, artifact);
    log(`review queue: ${items.length} item(s), P0=${artifact.summary.byPriority.P0}, P1=${artifact.summary.byPriority.P1}`);
}

main().catch((error) => {
    logError(error.stack ?? String(error));
    process.exitCode = 1;
});
