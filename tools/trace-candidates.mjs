// Show every attribution candidate for a cluster and which one won.
//
// Written because a cluster kept being attributed to a patch mod even after the namespace-matching
// tiers were corrected. The candidates are collected inside resolveMod, so the only way to see which
// rule actually fired is to reproduce the candidate list and print it.
//
// Usage: node trace-candidates.mjs <profile dir> <substring of the message>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const profileDir = process.argv[2];
const needle = process.argv[3];
if (!profileDir || !needle) {
  console.error('usage: node trace-candidates.mjs <profile dir> <substring>');
  process.exit(2);
}

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (name) => pathToFileURL(path.join(pluginRoot, 'lib', name)).href;
const detect = await import(lib('detect.js'));
const parse = await import(lib('parse.js'));

const env = detect.detectEnvironment();
const modlist = detect.activeModList(env.profile, env.config, { toolModRoots: [env.home + '\\toolmods'] });
const active = modlist.active ?? [];
const modRoots = modlist.modRoots ?? [];

const entries = fs.readFileSync(path.join(profileDir, 'RimCrow_Realtime.log'), 'utf8')
  .split('\n')
  .map((line) => parse.parseRealtimeLine(line))
  .filter(Boolean);

const clusters = parse.clusterProblems(entries, modRoots, active, env.indexes ?? {});
const mine = clusters.filter((c) => String(c.normalized).includes(needle.toLowerCase()));
console.log('clusters matching "' + needle + '": ' + mine.length);
console.log('');

for (const c of mine.slice(0, 1)) {
  console.log('=== cluster');
  console.log('  level : ' + c.level + '   occurrences: ' + c.occurrences);
  console.log('  norm  : ' + String(c.normalized).slice(0, 160));
  console.log('  modIds: ' + JSON.stringify([...c.modIds]));
  console.log('  files : ' + JSON.stringify([...c.files].slice(0, 5)));
  console.log('');
  console.log('  frames: ' + c.frames.length);
  for (const f of c.frames.slice(0, 10)) {
    console.log('     ' + String(f.method ?? '').slice(0, 90));
    console.log('        ' + String(f.file ?? '').slice(0, 130));
  }
  console.log('');
  console.log('  namedMods: ' + JSON.stringify([...(c.namedMods ?? [])]));
  console.log('');

  const names = new Set();
  for (const f of c.frames) {
    const hit = parse.modNameFromFramePath(f.file);
    if (hit) names.add('path:' + hit.name);
    const ns = /^([A-Z][A-Za-z0-9_]{2,40})\./.exec(f.method ?? '');
    if (ns && !/^(?:Verse|RimWorld|UnityEngine|System|MonoMod|HarmonyLib|Mono)$/.test(ns[1])) {
      names.add('namespace:' + ns[1]);
    }
  }
  console.log('  candidates derived from this cluster:');
  for (const n of names) console.log('     ' + n);
  console.log('');
  const resolved = parse.resolveMod(c, modRoots, active, env.indexes ?? {});
  console.log('  resolveMod says: ' + (resolved
    ? resolved.name + ' [' + resolved.packageId + '] conf=' + resolved.confidence + '  evidence=' + resolved.evidence
    : '(none)'));
}
