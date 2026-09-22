// Checks protocol dossier proof stages and links against retained exact-token evidence.
const { readFileSync } = require('node:fs'); const { join } = require('node:path');
const { buildProtocolDossiers, renderProtocolDossier, renderProtocolIndex } = require('./lib/protocol-dossiers.mjs');
const { protocolProofModel } = require('./lib/protocol-proof.js');
const read = (p) => JSON.parse(readFileSync(join(__dirname, '..', p), 'utf8'));
describe('protocol dossiers', () => {
 const rows = buildProtocolDossiers({ tokens: read('stocks-tokens.json').tokens, issuers: read('stocks-issuers.json').issuers, usage: read('stocks/data/defi-usage.json'), templates: read('stocks/data/composability-templates.json').templates });
 test('creates one stable dossier per observed integration without inventing execution proof', () => { expect(rows).toHaveLength(read('stocks/data/defi-usage.json').counts.integrations); expect(rows.some(r => r.integration.category === 'lending')).toBe(true); expect(rows.every(r => r.proof.configurationDecoded === false && r.proof.readOnlyExecutionSimulated === false)).toBe(true); });
 test('renders proof-derived headline, direct token/issuer links, account check, outcomes and lender limits', () => { const row = rows.find(r => r.integration.category === 'lending'); const html = renderProtocolDossier(row, { baseUrl: 'https://rwasonar.com' }); for (const marker of [row.mint, 'Achieved proof stage', 'Referenced accounts and owners', 'Configuration decoded', 'Borrower default / seizure', 'Protocol hack custody', 'Access or key loss', 'Lender exit after receiving the token', '@RWASonar', `../cards/${row.cardSlug}.html`, `../issuers/${row.issuer}.html`]) expect(html).toContain(marker); expect(html).toContain('Not performed'); expect(html).toContain('Exact-token support is source-listed'); expect(html).toContain('independently executed trades'); expect(html).toContain(`/protocols/${row.slug}.html`); });
 test('keeps source listing, decoding and simulation as distinct proof claims', () => {
  expect(protocolProofModel({ proof: { sourceStatus: 'exact-token-registry' } })).toMatchObject({ stage: 'source-listed', headline: 'Exact-token support is source-listed' });
  expect(protocolProofModel({ proof: { sourceStatus: 'exact-token-registry', configurationDecoded: true } })).toMatchObject({ stage: 'decoded', headline: 'Configuration was decoded for this exact token' });
  expect(protocolProofModel({ proof: { sourceStatus: 'exact-token-registry', configurationDecoded: true, readOnlyExecutionSimulated: true } })).toMatchObject({ stage: 'simulated', headline: 'Read-only execution was simulated for this exact token' });
 });
 test('joins issuer redemption into the lender-exit analysis instead of discarding it', () => { const row = rows.find(r => r.integration.category === 'lending' && r.issuer === 'xstocks-backed'); expect(row).toBeDefined(); expect(row.lenderExit.routes.issuerRedemption).toBe(true); });
 test('index groups the routes by protocol and keeps every token dossier reachable', () => { const html = renderProtocolIndex(rows); expect(html).toContain(`./${rows[0].slug}.html`); expect(html).toContain('exact-token integration'); expect((html.match(/<article>/g) ?? []).length).toBeLessThan(rows.length); });
});
