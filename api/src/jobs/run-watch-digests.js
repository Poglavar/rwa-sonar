// PM2 entry for the hourly personal watch digest (ecosystem.config.cjs rwa-watch-digest): runs
// send-watch-digests.js unconditionally. Kept apart so tests can import that module without
// starting a run.
import { runCli } from './send-watch-digests.js';

runCli(process.argv.slice(2));
