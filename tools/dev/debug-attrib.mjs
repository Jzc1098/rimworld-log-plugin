/** Focused debug: why a particular cluster is attributed the way it is. Dev aid. */

import { modNameFromFramePath, readLogEntries, messagePaths } from './lib/parse.js';
import { detectEnvironment, activeModList } from './lib/detect.js';

const env = detectEnvironment();
const read = readLogEntries(env.sources.realtime.path);
const entry = read.entries.find((e) => /not multiples of/.test(e.message));
console.log('entry level:', entry.level, 'count:', entry.count);
console.log('message:', entry.message);
console.log('\nframes:', entry.frames.length);
for (const [i, frame] of entry.frames.entries()) {
  console.log(`  ${i} ${frame.method}`);
  console.log(`      file=${frame.file ?? '(none)'}`);
  console.log(`      modNameFromFramePath=${JSON.stringify(modNameFromFramePath(frame.file))}`);
}
console.log('\nmessagePaths:', messagePaths(entry.message));

const mods = activeModList(env.profile, env.config, { toolModRoots: [`${env.home}\\toolmods`] });
const needle = 'graphicssetter';
const hit = mods.active.filter((m) => JSON.stringify(m).toLowerCase().includes(needle));
console.log('\nactive mods matching "graphicssetter":', hit.length);
for (const m of hit) console.log('  ', m.packageId, '|', m.name, '|', m.dir);
const fgl = mods.active.find((m) => m.packageId === 'taranchuk.fastergameloading');
console.log('\nFasterGameLoading entry:', JSON.stringify(fgl, null, 2));
console.log('\nactiveMods count:', mods.activeCount, 'missing:', mods.missingCount);
console.log('searchRoots:', mods.searchRoots.join('\n              '));
