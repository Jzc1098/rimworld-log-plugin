// Find Scribe_References calls in a decompiled C# dump, with surrounding context.
//
// Written while hunting the source of:
//   Cannot save reference to Vehicles.CompVehicleTurrets+TurretData item if it is not ILoadReferenceable
// Verse throws that from Scribe_References.Look when a field is declared as ILoadReferenceable (or an
// object holding one) but the value does not implement it. Finding the call site is the whole problem,
// and reading whole files to do it wastes context, so this prints only the calls plus a few lines of
// surroundings and the declaring member when one is obvious.
//
// Usage: node find-scribe-references.mjs <decompiled.cs> [<needle>]

import fs from 'node:fs';

const file = process.argv[2];
const needle = process.argv[3] ?? null;
if (!file) {
  console.error('usage: node find-scribe-references.mjs <decompiled.cs> [<needle>]');
  process.exit(2);
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const hits = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!/Scribe_References|Scribe_Deep\.Look|Scribe_Collections\.Look/.test(line)) continue;
  if (needle && !line.includes(needle)) {
    // Keep it if the needle appears within a small window - the type is often on the next line.
    const window = lines.slice(i, i + 4).join('\n');
    if (!window.includes(needle)) continue;
  }
  hits.push(i);
}

console.log('file    : ' + file);
console.log('hits    : ' + hits.length);
console.log('');

/** Walk backwards to the nearest member declaration, which names what owns the field. */
function ownerOf(index) {
  for (let i = index; i >= 0 && index - i < 60; i--) {
    const t = lines[i].trim();
    if (/^(public|private|protected|internal)\s/.test(t) && /\(/.test(t) && !/;\s*$/.test(t)) {
      return t;
    }
  }
  return '(unknown member)';
}

for (const i of hits.slice(0, 40)) {
  console.log('--- line ' + (i + 1) + ' ---');
  console.log('  owner: ' + ownerOf(i));
  for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 5); j++) {
    const mark = j === i ? ' >>' : '   ';
    console.log(mark + ' ' + lines[j].trimEnd());
  }
  console.log('');
}
