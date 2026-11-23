// Unit tests for stocks/lib/run-stages.mjs: the split ingest / processing verdicts the watchers
// write into their stats. Guards that a processing failure can never show up as an ingest failure
// and that the blended watchStatus stays as strict as before.

import { stageFail, stageOk, stageSkip, stageStats, stageTally, stageVerdict, worstStatus } from './lib/run-stages.mjs';

describe('stage verdicts', () => {
    test('ok, partial and failed follow the counts; failing steps are named worst first', () => {
        expect(stageVerdict(stageTally()).status).toBe('ok');
        const t = stageTally();
        stageOk(t, 3);
        stageFail(t, 'store-notices');
        stageFail(t, 'parse', 2);
        stageSkip(t);
        expect(stageVerdict(t)).toEqual({
            status: 'partial', attempted: 6, ok: 3, failed: 3, skipped: 1,
            failingSteps: [{ step: 'parse', count: 2 }, { step: 'store-notices', count: 1 }]
        });
        const all = stageFail(stageTally(), 'read-state');
        expect(stageVerdict(all).status).toBe('failed');
    });

    test('a processing failure leaves the ingest verdict ok', () => {
        const ingest = stageOk(stageTally(), 2);
        const processing = stageFail(stageOk(stageTally()), 'record-matches');
        const s = stageStats(ingest, processing);
        expect(s.ingestStatus).toBe('ok');
        expect(s.processingStatus).toBe('partial');
        expect(s.processing.failingSteps).toEqual([{ step: 'record-matches', count: 1 }]);
    });

    test('the blended status is the worst of its parts', () => {
        expect(worstStatus('ok', 'partial', 'ok')).toBe('partial');
        expect(worstStatus('partial', 'failed')).toBe('failed');
        expect(worstStatus('ok', 'ok')).toBe('ok');
    });
});
