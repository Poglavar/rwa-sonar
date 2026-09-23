// /api/changes on a database that has never run the change judge: sonar.change_judgment does not
// exist there, and the route must still answer — `modelAssessment: null` on every row, a note that
// says why, and a material filter that matches nothing — rather than a 500 from a missing relation.
// The database is replaced by a stub (no DATABASE_URL needed) that answers the to_regclass probe
// and fails any statement naming the table, exactly as Postgres would.

import { jest } from '@jest/globals';

const statements = [];
let tablePresent = false;

jest.unstable_mockModule('../src/db.js', () => ({
    describeDatabase: () => '(stub)',
    getPool: () => { throw new Error('the stub has no pool'); },
    closePool: async () => {},
    query: async (text, values = []) => {
        statements.push({ text, values });
        if (text.includes('to_regclass')) return { rows: [{ present: tablePresent }] };
        if (!tablePresent && text.includes('sonar.change_judgment')) {
            throw new Error('relation "sonar.change_judgment" does not exist');
        }
        if (text.startsWith('SELECT count(*)')) return { rows: [{ total: tablePresent ? 1 : 0 }] };
        return {
            rows: [{
                id: '7', kind: 'legal-term', detected_at: '2026-09-23T09:00:00Z',
                modelAssessment: tablePresent ? { status: 'valid', material: true } : null
            }]
        };
    }
}));

const { app } = await import('../src/app.js');

async function get(path) {
    const res = await app.request(path);
    return { status: res.status, body: await res.json() };
}

beforeEach(() => { statements.length = 0; });

describe('/api/changes without sonar.change_judgment', () => {
    beforeAll(() => { tablePresent = false; });

    test('answers 200 with null assessments and a note saying why', async () => {
        const { status, body } = await get('/api/changes?limit=5');
        expect(status).toBe(200);
        expect(body.items[0].modelAssessment).toBeNull();
        expect(body.modelAssessmentNote).toMatch(/sonar\.change_judgment does not exist/);
        expect(statements.some((s) => s.text.includes('sonar.change_judgment') && !s.text.includes('to_regclass')))
            .toBe(false);
    });

    test('a material filter matches nothing and the note says so', async () => {
        const { status, body } = await get('/api/changes?material=true');
        expect(status).toBe(200);
        expect(body.material).toBe(true);
        expect(body.modelAssessmentNote).toMatch(/material filter matches nothing/);
        expect(statements.find((s) => s.text.startsWith('SELECT count(*)')).text).toMatch(/AND FALSE$/);
    });

    test('a bad material value is a 400, not an ignored filter', async () => {
        const { status, body } = await get('/api/changes?material=maybe');
        expect(status).toBe(400);
        expect(body.error.code).toBe('bad_material');
    });
});

describe('/api/changes with sonar.change_judgment', () => {
    beforeAll(() => { tablePresent = true; });

    test('joins the judgments, passes material as a parameter and carries no note', async () => {
        const { status, body } = await get('/api/changes?material=false');
        expect(status).toBe(200);
        expect(body.modelAssessmentNote).toBeUndefined();
        const list = statements.find((s) => s.text.includes('AS "modelAssessment"'));
        expect(list.text).toContain('LEFT JOIN LATERAL');
        expect(list.values[0]).toBe(false);
    });
});
