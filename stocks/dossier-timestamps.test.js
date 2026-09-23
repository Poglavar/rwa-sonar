// Guards against invented time: every ISO timestamp an analyst writes into a dossier or an event
// resolution must already have happened. On 2026-09-23 a research pass wrote local clock times
// labelled "Z" (and rounded guesses), stamping claims up to an hour in the future — which the
// review queue then compared against real watcher times.
import { readFileSync, readdirSync } from 'node:fs';

const ISO = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)\b/g;
const SLACK_MS = 5 * 60 * 1000;

function futureStamps(text, nowMs) {
    const out = [];
    for (const m of text.matchAll(ISO)) {
        const t = Date.parse(m[1]);
        if (Number.isFinite(t) && t > nowMs + SLACK_MS) out.push(m[1]);
    }
    return out;
}

const files = [
    'stocks/data/event-resolutions.json',
    ...readdirSync('stocks/data/issuers').filter((f) => f.endsWith('.json')).map((f) => `stocks/data/issuers/${f}`)
];

describe('no timestamp in the research data is in the future', () => {
    test.each(files)('%s', (file) => {
        expect(futureStamps(readFileSync(file, 'utf8'), Date.now())).toEqual([]);
    });

    test('the detector flags a future stamp and ignores past ones', () => {
        const now = Date.parse('2026-09-23T10:00:00Z');
        expect(futureStamps('"accessedAt": "2026-09-23T11:10:00Z"', now)).toEqual(['2026-09-23T11:10:00Z']);
        expect(futureStamps('"accessedAt": "2026-09-23T09:51:55Z"', now)).toEqual([]);
    });
});
