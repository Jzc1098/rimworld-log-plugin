/**
 * Identify the two textures behind the 148 compression errors.
 *
 * The error reads "Texture '' has dimensions (64 x 65) ..." - the name is empty in the log, so the
 * dimensions are the only handle. This walks every enabled mod's Textures folder, reads each PNG's
 * IHDR, and reports the files that match 64x65 or 400x719 exactly, plus how many textures are
 * unaffected.
 *
 * Usage: node find-textures-by-size.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, { toolModRoots: [`${env.home}\\toolmods`] });

const roots = new Map();
for (const m of mods.active) {
  if (!m.installed || !m.dir) continue;
  let real = m.dir;
  try {
    real = fs.realpathSync(m.dir);
  } catch {
    /* keep original */
  }
  if (!roots.has(real)) roots.set(real, m.name);
}

const TARGETS = new Set(['64x65', '400x719']);

function pngSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(24);
    const read = fs.readSync(fd, buf, 0, 24, 0);
    if (read < 24) return null;
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const hits = [];
let scanned = 0;
const sizeHistogram = new Map();

for (const [modDir, modName] of roots) {
  const tex = path.join(modDir, 'Textures');
  if (!fs.existsSync(tex)) continue;
  const stack = [tex];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.png')) continue;
      scanned += 1;
      const s = pngSize(full);
      if (!s) continue;
      const key = `${s.w}x${s.h}`;
      const misaligned = (s.w % 4 !== 0) || (s.h % 4 !== 0);
      if (misaligned) sizeHistogram.set(key, (sizeHistogram.get(key) ?? 0) + 1);
      if (TARGETS.has(key)) {
        hits.push({ mod: modName, rel: full.replace(modDir, ''), w: s.w, h: s.h, bytes: fs.statSync(full).size });
      }
    }
  }
}

console.log(`PNG files scanned: ${scanned}`);
console.log(`distinct sizes where width or height is not a multiple of 4: ${sizeHistogram.size}`);
const top = [...sizeHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('  most common misaligned sizes:');
for (const [size, n] of top) console.log(`      ${size.padEnd(12)} ${n} file(s)`);
const totalMisaligned = [...sizeHistogram.values()].reduce((a, b) => a + b, 0);
console.log(`  total files with a misaligned dimension: ${totalMisaligned} of ${scanned}`);
const pct = ((totalMisaligned / scanned) * 100).toFixed(2);
console.log(`  -> ${pct}% of textures cannot be compressed; ${(100 - Number(pct)).toFixed(2)}% can`);

console.log('');
console.log(`=== files whose size is exactly one of the two reported (${hits.length}) ===`);
for (const h of hits) {
  console.log(`  ${h.w}x${h.h}  ${h.bytes.toString().padStart(7)} B  ${h.mod}`);
  console.log(`      ${h.rel}`);
}
if (hits.length === 0) console.log('  none found - the textures may come from a mod whose folder was not walked');
