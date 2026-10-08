// Exercise the same byte reader used by live, archived and cached source checks.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { bytesToText } from './lib/document-readers.mjs';
import { looksLikeDocx } from './lib/docx.mjs';
import { buildRegistry, classifyKind, kindFromContentType } from './lib/sources.mjs';
import { rawExtension, storedReading, sha256Hex, quoteVerdicts, readProvenance, severityForChange, selectSourceIds, sourceId, sourceWatchStatsFileName } from './lib/watch.mjs';
import { diffLines } from './lib/textdiff.mjs';

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const paragraph = (text) => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>';
function archive(entries) {
    return execFileSync('python3', ['-c', [
        'import io,json,sys,zipfile', 'out=io.BytesIO()',
        'with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:',
        ' for name,text in json.load(sys.stdin).items(): z.writestr(name,text)',
        'sys.stdout.buffer.write(out.getvalue())'
    ].join('\n')], { input: JSON.stringify(entries) });
}
function document(body, extra = {}) {
    return archive({
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="' + MIME + '.main+xml"/></Types>',
        'word/document.xml': '<w:document xmlns:w="' + W + '"><w:body>' + body + '</w:body></w:document>',
        ...extra
    });
}

test('extensionless DOCX bytes override generic MIME and keep tables, notes, formatting runs and accepted changes', async () => {
    const body = '<w:p><w:r><w:t>Redemp</w:t></w:r><w:r><w:t>tion fee</w:t></w:r></w:p>'
        + '<w:tbl><w:tr><w:tc>' + paragraph('$30') + '</w:tc><w:tc>' + paragraph('0.1%') + '</w:tc></w:tr></w:tbl>'
        + '<w:p><w:del><w:r><w:delText>Old clause</w:delText></w:r></w:del>'
        + '<w:moveFrom><w:r><w:t>Moved away</w:t></w:r></w:moveFrom>'
        + '<w:ins><w:r><w:t>New clause &amp; terms</w:t></w:r></w:ins></w:p>';
    const bytes = document(body, {
        'word/footnotes.xml': '<w:footnotes xmlns:w="' + W + '"><w:footnote w:id="-1">' + paragraph('Separator') + '</w:footnote><w:footnote w:id="1">' + paragraph('Receiving broker must accept.') + '</w:footnote></w:footnotes>',
        'word/header1.xml': '<w:hdr xmlns:w="' + W + '">' + paragraph('Account agreement') + '</w:hdr>',
        'docProps/core.xml': '<noise>Changed editor metadata</noise>'
    });
    expect(looksLikeDocx(bytes)).toBe(true);
    const read = await bytesToText(bytes, 'application/octet-stream', 'https://cdn.example/download?id=1');
    expect(read).toMatchObject({ kind: 'docx', via: 'docx', binary: false });
    for (const text of ['Redemption fee', '$30', '0.1%', 'Receiving broker must accept.', 'Account agreement', 'New clause & terms']) expect(read.text).toContain(text);
    expect(read.text).not.toMatch(/Old clause|Moved away|Separator|Changed editor/);
    expect(quoteVerdicts({ status: 'ok', kind: read.kind, text: read.quoteText, quotes: [{ id: 'fee', quote: 'Redemption fee $30 0.1%' }] }).found).toHaveLength(1);
    const cached = storedReading({ rawExt: 'docx', via: 'docx', payload: read.quoteText });
    expect(sha256Hex(cached.text)).toBe(sha256Hex(read.text));
    expect(readProvenance({ status: 'ok', via: 'docx' })).toEqual({ readVia: 'docx', captureAt: null });
    expect(rawExtension('docx')).toBe('docx');
});

test('a changed fee changes the normalized document and triggers the existing legal keyword diff', async () => {
    const before = await bytesToText(document(paragraph('Redemption fee: $30')), MIME, 'https://example.test/a');
    const after = await bytesToText(document(paragraph('Redemption fee: $45')), MIME, 'https://example.test/a');
    expect(sha256Hex(before.text)).not.toBe(sha256Hex(after.text));
    const diff = diffLines(before.text, after.text);
    expect(diff.addedLines).toContain('Redemption fee: $45');
    expect(severityForChange({ kind: 'docx', changedLines: diff.changedLines }).keywords).toEqual(expect.arrayContaining(['redemption']));
    expect(classifyKind('https://example.test/terms.DOCX')).toBe('docx');
    expect(kindFromContentType(MIME, 'https://example.test/download')).toBe('docx');
});

test('metadata-only changes do not change the document hash', async () => {
    const body = paragraph('No cash redemption.');
    const a = await bytesToText(document(body, { 'docProps/core.xml': '<edited>1</edited>' }), MIME, '');
    const b = await bytesToText(document(body, { 'docProps/core.xml': '<edited>2</edited>' }), MIME, '');
    expect(sha256Hex(a.text)).toBe(sha256Hex(b.text));
});

test('non-Word ZIP files remain binary and malformed Word documents fail instead of creating a baseline', async () => {
    const zip = archive({ 'report.txt': 'not a Word document' });
    expect(looksLikeDocx(zip)).toBe(false);
    expect(await bytesToText(zip, 'application/zip', 'https://example.test/a.zip')).toMatchObject({ via: 'binary' });
    await expect(bytesToText(Buffer.from('broken'), MIME, '')).rejects.toThrow(/DOCX reader/);
    const xml = document('<w:p>broken');
    await expect(bytesToText(xml, MIME, '')).rejects.toThrow(/DOCX reader/);
});

test('XML entity declarations are rejected without reading external files', async () => {
    const bytes = document('', {
        'word/document.xml': '<!DOCTYPE doc [<!ENTITY ext SYSTEM "file:///etc/passwd">]><w:document xmlns:w="' + W + '"><w:p><w:r><w:t>&ext;</w:t></w:r></w:p></w:document>'
    });
    await expect(bytesToText(bytes, MIME, '')).rejects.toThrow(/DTD\/entity/);
});


test('explicit formats identify opaque downloads and targeted runs include shared sources without changing the heartbeat', () => {
    const doc = { documents: [{ title: 'Agreement', url: 'https://cdn.example/opaque', format: 'docx' }] };
    const registry = buildRegistry([{ slug: null, doc }], { generatedAt: '2026-10-08T18:00:00Z' });
    expect(registry.items[0]).toMatchObject({ kind: 'docx', issuer: null });
    const id = sourceId(registry.items[0].url);
    expect(selectSourceIds(registry.items, id)).toEqual(registry.items);
    expect(() => selectSourceIds(registry.items, 'bad')).toThrow(/source/);
    expect(() => selectSourceIds(registry.items, 'abcdef123456')).toThrow(/unknown/);
    expect(sourceWatchStatsFileName({ sources: id })).not.toBe('.last-source-watch-stats.json');
});


test('both database source-kind and reader-provenance constraints accept DOCX', () => {
    const kind = readFileSync(new URL('../db/2026-10-08-sonar-source-docx.sql', import.meta.url), 'utf8');
    const provenance = readFileSync(new URL('../db/2026-09-23-sonar-source-provenance.sql', import.meta.url), 'utf8');
    expect(kind).toMatch(/CHECK \(kind IN \([^)]*'docx'/);
    expect(provenance.match(/read_via IN \([^)]*'docx'/g)).toHaveLength(2);
});
