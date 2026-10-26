/** Print the full text of log entries matching a pattern. Dev aid. */

import { detectEnvironment } from './lib/detect.js';
import { readLogEntries } from './lib/parse.js';

const pattern = process.argv[2] ?? 'RimCrow log fix';
const limit = Number(process.argv[3] ?? 3);

const env = detectEnvironment();
const read = readLogEntries(env.sources.realtime.path);
const hits = read.entries.filter((e) => new RegExp(pattern, 'i').test(`${e.message}\n${e.details}`));

console.log(`matched ${hits.length} entries for /${pattern}/i  (total log entries: ${read.entries.length})\n`);
for (const entry of hits.slice(0, limit)) {
  console.log('='.repeat(100));
  console.log(`[${entry.level}] ${entry.time}  count=${entry.count}`);
  console.log(entry.message);
  if (entry.details) {
    console.log('--- details ---');
    console.log(entry.details.slice(0, 4000));
  }
  console.log('');
}
