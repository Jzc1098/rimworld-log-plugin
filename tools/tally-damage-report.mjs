// Tally the Vehicle Framework damage report so the effect of a patch can be judged from data.
//
// The reports are the only place where the resolved damage against a vehicle component is printed, so
// counting the distinct values of "Component Damage" and "component health" answers directly whether
// damage is landing. A single repeated health value across hundreds of hits means nothing is getting
// through.
//
// Usage: node tally-damage-report.mjs <realtime log> [--component <key>]

import fs from 'node:fs';

const logPath = process.argv[2];
if (!logPath) {
  console.error('usage: node tally-damage-report.mjs <realtime log> [--component <key>]');
  process.exit(2);
}

const keyIndex = process.argv.indexOf('--component');
const onlyKey = keyIndex > 0 ? process.argv[keyIndex + 1] : null;

const lines = fs.readFileSync(logPath, 'utf8').split('\n');

const byDamage = new Map();
const byBulk = new Map();
const byArmor = new Map();
const byHealth = new Map();
let reports = 0;
let relevant = 0;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

for (const line of lines) {
  if (!line.includes('DAMAGE REPORT')) continue;
  reports++;

  const m = /"message":"((?:[^"\\]|\\.)*)"/.exec(line);
  if (!m) continue;
  const text = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');

  if (onlyKey && !text.includes('to ' + onlyKey)) continue;
  relevant++;

  for (const [map, re] of [
    [byDamage, /Component Damage: ([-\d.]+)/],
    [byBulk, /deflected by component bulk\? (\w+)/],
    [byArmor, /deflected by component armor\? (\w+)/],
    [byHealth, /component health\? ([-\d.]+)/],
  ]) {
    const mm = re.exec(text);
    if (mm) bump(map, mm[1]);
  }
}

function show(title, map, limit) {
  console.log('');
  console.log('  ' + title + '  (' + map.size + ' distinct)');
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of entries.slice(0, limit)) {
    console.log('    ' + String(k).padStart(16) + '  x' + v);
  }
  if (entries.length > limit) {
    console.log('    ... ' + (entries.length - limit) + ' more');
  }
}

console.log('  damage reports in log : ' + reports);
if (onlyKey) console.log('  reports for "' + onlyKey + '" : ' + relevant);

show('Component Damage', byDamage, 15);
show('deflected by component bulk', byBulk, 5);
show('deflected by component armor', byArmor, 5);
show('component health', byHealth, 15);
