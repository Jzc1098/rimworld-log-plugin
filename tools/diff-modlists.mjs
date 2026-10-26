// Diff two RimCrow saved mod lists (.rml) to find what was added or removed.
//
// Written while diagnosing a startup failure that reset the mod list: the question that matters is
// which mods are new, because a mod present in an older working snapshot cannot by itself explain a
// regression. Reads only the <modList><ids> section, which is the active list.
//
// Usage: node diff-modlists.mjs <older.rml> <newer.rml>

import fs from 'node:fs';

const [olderPath, newerPath] = process.argv.slice(2);
if (!olderPath || !newerPath) {
  console.error('usage: node diff-modlists.mjs <older.rml> <newer.rml>');
  process.exit(2);
}

function readIds(file) {
  const text = fs.readFileSync(file, 'utf8');
  const listSection = /<modList>([\s\S]*?)<\/modList>/.exec(text);
  if (!listSection) throw new Error('no <modList> in ' + file);
  const idsSection = /<ids>([\s\S]*?)<\/ids>/.exec(listSection[1]);
  if (!idsSection) throw new Error('no <ids> in ' + file);
  return [...idsSection[1].matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
}

const older = readIds(olderPath);
const newer = readIds(newerPath);
const olderSet = new Set(older);
const newerSet = new Set(newer);

console.log('older: ' + olderPath);
console.log('       ' + older.length + ' mods');
console.log('newer: ' + newerPath);
console.log('       ' + newer.length + ' mods');
console.log('');

const added = newer.filter((id) => !olderSet.has(id));
const removed = older.filter((id) => !newerSet.has(id));

console.log('=== added (' + added.length + ') ===');
for (const id of added) console.log('  + ' + id);

console.log('');
console.log('=== removed (' + removed.length + ') ===');
for (const id of removed) console.log('  - ' + id);

// Also report order changes, which can matter for Harmony patch ordering.
const common = newer.filter((id) => olderSet.has(id));
let moved = 0;
for (let i = 0; i < common.length; i++) {
  const id = common[i];
  const oldIndex = older.indexOf(id);
  if (oldIndex !== i) moved++;
}
console.log('');
console.log('common mods whose position changed: ' + moved + ' of ' + common.length);
