// Timestamped console logging, same shape as the stocks pipeline's stocks/lib/io.mjs so one
// PM2 log file reads consistently: `[2026-09-17T12:00:00Z] message`.

/** ISO timestamp trimmed to whole seconds, e.g. 2026-09-17T12:00:00Z. */
export function ts(date = new Date()) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function log(...args) {
    console.log(`[${ts()}]`, ...args);
}

export function logWarn(...args) {
    console.log(`[${ts()}] WARN`, ...args);
}

export function logError(...args) {
    console.error(`[${ts()}] ERROR`, ...args);
}
