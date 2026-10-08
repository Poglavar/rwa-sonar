// Shared live/archive document readers. Extraction stays independently testable from watcher orchestration.
import { spawn } from 'node:child_process';
import { logWarn } from './io.mjs';
import { kindFromContentType } from './sources.mjs';
import { docxToText, looksLikeDocx } from './docx.mjs';
import { binaryMarker, htmlDocumentText, isTextual, looksLikePdf, looksLikeText, normaliseByKind } from './watch.mjs';

/** PDF bytes -> layout-preserving text. stdin/stdout only: no temp file is ever written. */
export function pdfToText(buffer) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('pdftotext', ['-layout', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = [];
        let err = '';
        child.stdout.on('data', (d) => chunks.push(d));
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => rejectPromise(new Error(`pdftotext: ${e.message}`)));
        child.on('close', (code) => {
            const text = Buffer.concat(chunks).toString('utf8');
            // pdftotext exits non-zero on a damaged file but may still have produced pages.
            if (code !== 0 && text.trim() === '') {
                rejectPromise(new Error(`pdftotext exited ${code}: ${err.trim().slice(0, 200)}`));
                return;
            }
            if (code !== 0) logWarn(`pdftotext exited ${code} but produced ${text.length} chars: ${err.trim().slice(0, 120)}`);
            resolvePromise(text);
        });
        child.stdin.on('error', (e) => rejectPromise(new Error(`pdftotext stdin: ${e.message}`)));
        child.stdin.end(buffer);
    });
}

/**
 * A fetched body -> `{kind, text, via, binary}`: PDF through pdftotext, textual payloads through
 * the kind's normaliser (HTML with the Next.js flight reader, lib/watch.mjs `htmlDocumentText`),
 * anything else watched as bytes. Shared by the live fetch and the Wayback fallback, so a capture
 * is read exactly the way the live page would have been.
 */
export async function bytesToText(buffer, contentType, url) {
    let kind = kindFromContentType(contentType, url);
    // Drive answers every download as `application/octet-stream`, so the bytes have the last
    // word about what was served (lib/watch.mjs `looksLikePdf`).
    if (looksLikePdf(buffer)) kind = 'pdf';
    else if (looksLikeDocx(buffer)) kind = 'docx';
    if (kind === 'docx') {
        const text = await docxToText(buffer);
        return { kind, text: normaliseByKind(kind, text), quoteText: normaliseByKind(kind, text, { keepChurn: true }), via: 'docx', binary: false };
    }
    if (kind === 'pdf') {
        const pdfText = await pdfToText(buffer);
        return {
            kind, text: normaliseByKind('pdf', pdfText), quoteText: normaliseByKind('pdf', pdfText, { keepChurn: true }), via: 'pdf', binary: false
        };
    }
    // Labelled bytes but really UTF-8 text (a Markdown file served as octet-stream): read it.
    if (isTextual(contentType) || !contentType || looksLikeText(buffer)) {
        if (kind === 'html') {
            const read = htmlDocumentText(buffer.toString('utf8'));
            return { kind, text: read.text, quoteText: read.quoteText, via: read.via, binary: false };
        }
        const body = buffer.toString('utf8');
        return {
            kind, text: normaliseByKind(kind, body), quoteText: normaliseByKind(kind, body, { keepChurn: true }), via: kind, binary: false
        };
    }
    // Not text and not a PDF (a zip of attestations, say): watched as bytes.
    const marker = binaryMarker(buffer, contentType);
    return { kind, text: marker, quoteText: marker, via: 'binary', binary: true };
}
