// Track one component's health across every damage report in the log, to see whether it ever drops.
//
// The reports print both the component hit and its health, so the sequence answers the question the
// code alone could not: is the component actually taking damage, or does every hit resolve to zero?
// A constant value across many hits means damage is fully deflected and the component can never die,
// which is what keeps Vehicle Framework's explosive reactor re-igniting forever.
//
// Usage: node trace-component-health.mjs <realtime log> <componentKey>
//   node trace-component-health.mjs <log> ThirdBooster

import fs from 'node:fs';

const logPath = process.argv[2];
const key = process.argv[3];
if (!logPath || !key) {
  console.error('usage: node trace-component-health.mjs <realtime log> <componentKey>');
  process.exit(2);
}

const lines = fs.readFileSync(logPath, 'utf8').split('\n');
const rows = [];

for (const line of lines) {
  if (!line.includes('DAMAGE REPORT')) continue;
  let message = '';
  const m = /"message":"((?:[^"\\]|\\.)*)"/.exec(line);
  if (!m) continue;
  message = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  if (!message.includes('to ' + key)) continue;

  let ts = '';
  const t = /"timestamp":"([^"]+)"/.exec(line);
  if (t) ts = t[1].slice(11, 19);

  const health = /component health\? ([\d.]+)/.exec(message);
  const bulk = /deflected by component bulk\? (\w+)/.exec(message);
  const armorDefl = /deflected by component armor\? (\w+)/.exec(message);
  const compDmg = /Component Damage: ([\d.]+)/.exec(message);
  const base = /Base Damage: ([\d.]+)/.exec(message);
  const fallthrough = /Fallthrough Damage = ([\d.]+)/.exec(message);

  rows.push({
    ts,
    health: health ? Number(health[1]) : null,
    bulk: bulk ? bulk[1] : '?',
    armorDefl: armorDefl ? armorDefl[1] : '?',
    compDmg: compDmg ? Number(compDmg[1]) : null,
    base: base ? Number(base[1]) : null,
    fallthrough: fallthrough ? Number(fallthrough[1]) : null,
  });
}

console.log('hits on "' + key + '": ' + rows.length);
console.log('');

// The health values are the whole point: print the distinct values and how often each occurs.
const byHealth = new Map();
for (const r of rows) {
  const k = r.health === null ? 'null' : r.health.toFixed(6);
  if (!byHealth.has(k)) byHealth.set(k, 0);
  byHealth.set(k, byHealth.get(k) + 1);
}

console.log('distinct health values seen when this component was hit:');
for (const [h, n] of [...byHealth.entries()].sort((a, b) => b[1] - a[1])) {
  console.log('  health=' + h.padEnd(14) + ' x' + n);
}

const byDmg = new Map();
for (const r of rows) {
  const k = r.compDmg === null ? 'null' : String(r.compDmg);
  if (!byDmg.has(k)) byDmg.set(k, 0);
  byDmg.set(k, byDmg.get(k) + 1);
}
console.log('');
console.log('distinct "Component Damage" values:');
for (const [d, n] of [...byDmg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('  Component Damage=' + d.padEnd(10) + ' x' + n);
}

console.log('');
console.log('first 12 hits in order:');
console.log('  time      base  armorDefl  bulkDefl  compDmg  health');
for (const r of rows.slice(0, 12)) {
  console.log('  ' + r.ts
    + '  ' + String(r.base).padStart(4)
    + '  ' + String(r.armorDefl).padStart(9)
    + '  ' + String(r.bulk).padStart(8)
    + '  ' + String(r.compDmg).padStart(7)
    + '  ' + String(r.health).padStart(10));
}

console.log('');
console.log('last 6 hits:');
for (const r of rows.slice(-6)) {
  console.log('  ' + r.ts
    + '  ' + String(r.base).padStart(4)
    + '  ' + String(r.armorDefl).padStart(9)
    + '  ' + String(r.bulk).padStart(8)
    + '  ' + String(r.compDmg).padStart(7)
    + '  ' + String(r.health).padStart(10));
}
