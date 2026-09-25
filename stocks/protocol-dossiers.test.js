// Checks protocol dossier proof stages and links against retained exact-token evidence.
const { readFileSync } = require('node:fs'); const { join } = require('node:path');
const { buildProtocolDossiers, renderProtocolDossier, renderProtocolIndex } = require('./lib/protocol-dossiers.mjs');
const { protocolProofModel } = require('./lib/protocol-proof.js');
const read = (p) => JSON.parse(readFileSync(join(__dirname, '..', p), 'utf8'));
describe('protocol dossiers', () => {
 const rows = buildProtocolDossiers({ tokens: read('stocks-tokens.json').tokens, issuers: read('stocks-issuers.json').issuers, usage: read('stocks/data/defi-usage.json'), templates: read('stocks/data/composability-templates.json').templates });
 const researchedRows = buildProtocolDossiers({ tokens: read('stocks-tokens.json').tokens, issuers: read('stocks-issuers.json').issuers, usage: read('stocks/data/defi-usage.json'), templates: read('stocks/data/composability-templates.json').templates, marketResearch: read('stocks/data/protocol-market-research.json') });
 test('creates one stable dossier per observed integration without inventing execution proof', () => { expect(rows).toHaveLength(read('stocks/data/defi-usage.json').counts.integrations); expect(rows.some(r => r.integration.category === 'lending')).toBe(true); expect(rows.every(r => r.proof.configurationDecoded === (r.integration.decoding != null) && r.proof.readOnlyExecutionSimulated === false)).toBe(true); });
 test('renders proof-derived headline, direct token/issuer links, account check, outcomes and lender limits', () => { const row = rows.find(r => r.integration.category === 'lending' && r.integration.decoding == null); const html = renderProtocolDossier(row, { baseUrl: 'https://rwasonar.com' }); for (const marker of [row.mint, 'Achieved proof stage', 'Referenced accounts and owners', 'Configuration decoded', 'Borrower default / seizure', 'Protocol hack custody', 'Access or key loss', 'Lender exit after receiving the token', '@RWASonar', `../cards/${row.cardSlug}.html`, `../issuers/${row.issuer}.html`]) expect(html).toContain(marker); expect(html).toContain('Not performed'); expect(html).toContain('Exact-token support is source-listed'); expect(html).toContain('independently executed trades'); expect(html).toContain(`/protocols/${row.slug}.html`); });
 test('keeps source listing, decoding and simulation as distinct proof claims', () => {
 expect(protocolProofModel({ proof: { sourceStatus: 'exact-token-registry' } })).toMatchObject({ stage: 'source-listed', headline: 'Exact-token support is source-listed' });
  expect(protocolProofModel({ proof: { sourceStatus: 'exact-token-registry' }, fetchedAt: '2026-09-20T10:38:22Z' })).toMatchObject({ asOf: '2026-09-20T10:38:22Z' });
  expect(protocolProofModel({ proof: { sourceStatus: 'exact-token-registry', configurationDecoded: true } })).toMatchObject({ stage: 'decoded', headline: 'Configuration was decoded for this exact token' });
  expect(protocolProofModel({ proof: { sourceStatus: 'exact-token-registry', configurationDecoded: true, readOnlyExecutionSimulated: true } })).toMatchObject({ stage: 'simulated', headline: 'Read-only execution was simulated for this exact token' });
 });
 test('promotes only the reviewed NVDAx Kamino route to decoded and keeps execution unproved', () => {
  const row = researchedRows.find(r => r.mint === 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' && r.integration.protocolId === 'kamino');
  expect(row).toBeDefined();
  expect(row.proof).toMatchObject({ configurationDecoded: true, readOnlyExecutionSimulated: false, observedAt: '2026-09-22T16:01:56Z' });
  expect(row.marketVerifications).toHaveLength(1);
  const html = renderProtocolDossier(row);
  expect(html).toContain('NVDAx collateral → USDC debt · xStocks Pool');
  expect(html).toContain('matches official mainnet programme ID');
  expect(html).toContain('55%');
  expect(html).toContain('65%');
  expect(html).toContain('16,000,000');
  expect(html).toContain('still not proof that a particular borrow transaction succeeded');
 });
 test('docs-vs-chain findings and exit dependencies are compact fold rows with both sides and sources in the opened body', () => {
  const row = researchedRows.find(r => r.marketVerifications.some(m => (m.discrepancies ?? []).length > 0));
  expect(row).toBeDefined();
  const html = renderProtocolDossier(row);
  const rowOf = (id) => { const start = html.indexOf(`<li id="${id}" class="fold-row`); if (start < 0) return null; const rest = html.slice(start); const next = rest.indexOf('class="fold-row', rest.indexOf('>')); const one = next < 0 ? rest : rest.slice(0, next);
   return { tag: one.slice(0, one.indexOf('>') + 1), summary: one.match(/<summary>([\s\S]*?)<\/summary>/)[1], body: one.slice(one.indexOf('<div class="fold-body">')) }; };
  const finding = row.marketVerifications.flatMap(m => m.discrepancies ?? []).find(d => d.id === 'loopscale-upgrade-multisig-threshold');
  const folded = rowOf('discrepancy-loopscale-upgrade-multisig-threshold');
  expect(folded).not.toBeNull();
  expect(folded.tag).toBe('<li id="discrepancy-loopscale-upgrade-multisig-threshold" class="fold-row fold-info">');
  expect(folded.summary).toContain('23 Sep 2026');
  expect(folded.summary).toContain('<b class="fold-chip">info</b>');
  expect(folded.summary).toContain('3-of-5 multisig');
  expect(folded.summary).toContain('<span class="fold-line2">The chain is stricter than the docs');
  expect(folded.summary).not.toContain('<a ');
  expect(folded.body).toContain('Published claim');
  expect(folded.body).toContain('Observed reality');
  expect(folded.body).toContain('href="https://docs.loopscale.com/partners/curators/security"');
  expect(folded.body).toContain('href="https://solscan.io/account/C4awuufiuL8DNT5wMDP27HneKKqbgynrsbCa4XYGSuPk"');
  expect(folded.body).toContain('What resolves it');
  expect(folded.body).toContain(finding.classification);
  // The lender-exit dependency: one row per appearance, the long statement only when opened.
  const dependency = row.marketVerifications.flatMap(m => m.lenderExitDependencies ?? [])[0];
  expect(html).toContain('<strong class="fold-title">Issuer action required</strong>');
  expect(html.split(`<span class="fold-line2">${dependency.consequence.slice(0, 40)}`).length - 1).toBe(2);
  expect(html).toContain('href="https://solscan.io/token/5VzwKkvynPJzcgwhBe7ESEyNgqMbo15yBu7Sehssd9ED"');
 });
 test('joins issuer redemption into the lender-exit analysis instead of discarding it', () => { const row = rows.find(r => r.integration.category === 'lending' && r.issuer === 'xstocks-backed'); expect(row).toBeDefined(); expect(row.lenderExit.routes.issuerRedemption).toBe(true); });
 test('index groups the routes by protocol and keeps every token dossier reachable', () => { const html = renderProtocolIndex(rows); expect(html).toContain(`./${rows[0].slug}.html`); expect(html).toContain('exact-token integration'); expect((html.match(/<article>/g) ?? []).length).toBeLessThan(rows.length); });
});
