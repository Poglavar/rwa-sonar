import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Hono } from 'hono';

import { getPool, query } from '../db.js';
import { notFound } from '../lib/query.js';
import { parseResolutionPayload, publicResolution, requireReviewToken } from '../lib/review.js';

const routes = new Hono();
const QUEUE_PATH = process.env.REVIEW_QUEUE_FILE
    ? resolve(process.cwd(), process.env.REVIEW_QUEUE_FILE)
    : join(import.meta.dirname, '..', '..', '..', 'stocks-review-queue.json');

function queueItem(id) {
    const artifact = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
    return (artifact.items ?? []).find((item) => item.id === id) ?? null;
}

routes.use('/review/*', async (c, next) => {
    requireReviewToken(c.req.header('Authorization'));
    await next();
});

routes.get('/review/resolutions', async (c) => {
    const itemId = c.req.query('itemId');
    const values = itemId ? [itemId] : [];
    const where = itemId ? 'WHERE review_item_id = $1' : '';
    const result = await query(`SELECT * FROM sonar.review_resolution ${where} ORDER BY created_at DESC LIMIT 500`, values);
    return c.json({ count: result.rows.length, items: result.rows.map(publicResolution) });
});

routes.post('/review/resolutions', async (c) => {
    const payload = parseResolutionPayload(await c.req.json().catch(() => null));
    const item = queueItem(payload.itemId);
    if (!item) throw notFound('the review item is no longer open; refresh the queue');
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const inserted = await client.query(`INSERT INTO sonar.review_resolution
            (review_item_id, event_id, issuer_slug, field, issue, resolution, note, reviewer,
             previous_text, current_text, claim_impact)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [
            item.id, item.eventId, item.issuerSlug, item.field, item.issue, payload.resolution,
            payload.note, payload.reviewer, item.previousText, item.currentText, item.claimImpact
        ]);
        if (item.eventId !== null && payload.resolution !== 'deferred') {
            await client.query(`UPDATE sonar.change_event SET acknowledged_at = now(), updated_at = now()
                WHERE id = $1 AND acknowledged_at IS NULL`, [item.eventId]);
        }
        await client.query('COMMIT');
        return c.json({ item: publicResolution(inserted.rows[0]), eventAcknowledged: item.eventId !== null && payload.resolution !== 'deferred' }, 201);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
});

export default routes;
