// Bounded DOCX extraction using Python's standard-library ZIP/XML readers; no office process or network.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const READER = fileURLToPath(new URL('./docx-text.py', import.meta.url));
const MAX_BYTES = 24 * 1024 * 1024;

/** Extensionless CDN downloads identify themselves by their ZIP entries, not their URL. */
export function looksLikeDocx(buffer) {
    return Buffer.isBuffer(buffer) && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
        && buffer.includes(Buffer.from('[Content_Types].xml'))
        && buffer.includes(Buffer.from('word/document.xml'));
}

export function docxToText(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_BYTES) {
        return Promise.reject(new Error('DOCX input exceeds 24 MiB or is not a buffer'));
    }
    return new Promise((resolve, reject) => {
        const child = execFile('python3', [READER], { timeout: 30_000, maxBuffer: MAX_BYTES }, (error, stdout, stderr) => {
            if (error) reject(new Error('DOCX reader: ' + (stderr.trim() || error.message).slice(0, 500)));
            else resolve(stdout);
        });
        child.stdin.on('error', (error) => reject(new Error('DOCX reader stdin: ' + error.message)));
        child.stdin.end(buffer);
    });
}
