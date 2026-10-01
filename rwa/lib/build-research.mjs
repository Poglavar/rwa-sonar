// Joins curated product reviews with programme-scoped stock dossiers and independently dated chain reads.
import research from './research.js';
import monitor from './monitor.js';
import { stockResearch } from './stock-research.mjs';
export function buildResearch(curated, issuers, tokens, dossiers = {}, observations = { records: {} }, now = new Date().toISOString()) {
    research.validateResearch(curated);
    const products = [...structuredClone(curated.products), ...stockResearch(issuers, tokens, dossiers)];
    const records = observations.records || {};
    for (const p of products) for (const d of p.deployments) {
        const record = records[d.id];
        d.monitoring = { coverage: monitor.coverage(d, record, Date.parse(now)), configured: Boolean(record?.configured), cadenceSeconds: record?.cadenceSeconds || null,
            lastAttemptAt: record?.lastAttemptAt || null, lastAttemptStatus: record?.lastAttemptStatus || null, lastSuccessAt: record?.lastSuccessAt || null, lastError: record?.lastError || null };
        if (!record?.observation) continue;
        d.observation = structuredClone(record.observation);
        d.chainCheckedAt = record.lastSuccessAt;
        d.controls = { state: 'supported', summary: `Chain state observed at the block or slot below. Unknown fields and controller governance remain unresolved. Latest attempt: ${record.lastAttemptStatus}.` };
    }
    const data = { schemaVersion: 1, builtAt: now, products, monitoringRecords: records, counts: monitor.counts(products, records, Date.parse(now)) };
    return research.validateResearch(data);
}
