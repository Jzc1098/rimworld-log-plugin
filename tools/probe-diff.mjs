/**
 * Strict side-by-side comparison of the two structurally identical defs:
 *
 *   Ammo_MeltaGun        (Combat Extended)          - loads fine
 *   Ammo_180mm_nade_HEAT (Kiiro EXTRA Calibers)     - "No textures found at path"
 *
 * Both are concrete ammo ThingDefs, both declare Graphic_StackCount, both point their texPath at a
 * folder holding exactly NAME_a/_b/_c.png, and both carry the CE_AutoEnableCrafting_GWAmmoBench
 * tag. Anything that differs here is a candidate cause.
 *
 * Usage: node probe-diff.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function pngChunks(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { error: 'not png' };
  const chunks = [];
  let off = 8;
  let ihdr = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, len });
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    }
    if (type === 'pHYs') {
      ihdr.pHYs = { x: data.readUInt32BE(0), y: data.readUInt32BE(4), unit: data[8] === 1 ? 'metre' : 'unknown' };
    }
    if (type === 'IEND') break;
    off += 12 + len + 0; // length(4) + type(4) + data + crc(4)
    off = off - 0; // recompute cleanly below
  }
  return { chunks, ihdr };
}

/** A simpler, correct chunk walk. */
function pngInfo(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  const chunks = [];
  let off = 8;
  let ihdr = null;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push(`${type}(${len})`);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        bit: data[8],
        color: data[9],
        interlace: data[12],
      };
    }
    if (type === 'pHYs') ihdr.pHYs = `${data.readUInt32BE(0)}x${data.readUInt32BE(4)} ${data[8] === 1 ? 'per-metre' : 'aspect'}`;
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const s = data.toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 60);
      ihdr.profile = `${type}: ${s}`;
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return { chunks: chunks.join(' '), ihdr, bytes: buf.length };
}

// 工坊内容根（公开版不写死本机路径）：WORKSHOP_DIR=<steamapps\workshop\content\294100>
const WS = process.env.WORKSHOP_DIR;
if (!WS) {
  console.error('请设置 WORKSHOP_DIR（Steam 工坊 294100 目录）');
  process.exit(2);
}

const cases = [
  {
    label: 'Ammo_MeltaGun   (Combat Extended) - works',
    def: 'Ammo_MeltaGun',
    texPath: 'ThirdParty/Warhammer/Ammo/MeltaGun',
    dir: path.join(WS, '2890901044', 'Textures', 'ThirdParty', 'Warhammer', 'Ammo', 'MeltaGun'),
    xml: path.join(WS, '2890901044', 'Defs', 'Ammo', 'Modded', 'Warhammer 40k', 'MeltaGun.xml'),
    defNameInFile: 'Ammo_MeltaGun',
  },
  {
    label: 'Ammo_180mm_nade_HEAT (Kiiro EXTRA) - fails',
    def: 'Ammo_180mm_nade_HEAT',
    texPath: 'Things/Ammo/180mm_nade/HEAT180AT97',
    dir: path.join(WS, '3679716499', 'Textures', 'Things', 'Ammo', '180mm_nade'),
    xml: path.join(WS, '3679716499', '1.6', 'Patches', 'CE', '180mm_nade.xml'),
    defNameInFile: 'Ammo_180mm_nade_HEAT',
  },
];

for (const c of cases) {
  console.log('='.repeat(78));
  console.log(c.label);
  console.log('='.repeat(78));
  console.log(`  def           ${c.def}`);
  console.log(`  texPath       ${c.texPath}`);
  console.log(`  textures dir  ${c.dir}`);
  console.log(`  dir exists    ${fs.existsSync(c.dir)}`);

  const xml = fs.readFileSync(c.xml, 'utf8');
  const re = new RegExp(`<ThingDef\\b[^>]*>(?:(?!</ThingDef>)[\\s\\S])*?<defName>\\s*${c.defNameInFile}\\s*</defName>[\\s\\S]*?</ThingDef>`);
  const block = re.exec(xml);
  if (block) {
    console.log('  --- def XML ---');
    for (const line of block[0].split('\n')) console.log(`      ${line.trimEnd()}`);
  } else {
    console.log('  (def block not located by regex)');
  }

  console.log('  --- texture files ---');
  const files = fs.readdirSync(c.dir).sort();
  for (const f of files) {
    const p = path.join(c.dir, f);
    const info = pngInfo(p);
    const hash = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
    console.log(`      ${f}`);
    console.log(`          bytes=${info.bytes}  md5=${hash}`);
    console.log(`          ihdr=${JSON.stringify(info.ihdr)}`);
    console.log(`          chunks=${info.chunks}`);
  }
  console.log('');
}

console.log('='.repeat(78));
console.log('DIFFERENCES SUMMARY');
console.log('='.repeat(78));
const [a, b] = cases.map((c) => {
  const files = fs.readdirSync(c.dir).sort();
  const infos = files.map((f) => pngInfo(path.join(c.dir, f)));
  return {
    label: c.label,
    fileCount: files.length,
    sizes: infos.map((i) => `${i.ihdr.w}x${i.ihdr.h}`),
    colorTypes: infos.map((i) => i.ihdr.color),
    chunkSets: infos.map((i) => i.chunks),
    totalBytes: infos.reduce((s, i) => s + i.bytes, 0),
  };
});
console.log(`  working: files=${a.fileCount} sizes=${a.sizes.join(',')} colorTypes=${a.colorTypes.join(',')} total=${a.totalBytes}B`);
for (const cs of a.chunkSets) console.log(`      chunks: ${cs}`);
console.log(`  failing: files=${b.fileCount} sizes=${b.sizes.join(',')} colorTypes=${b.colorTypes.join(',')} total=${b.totalBytes}B`);
for (const cs of b.chunkSets) console.log(`      chunks: ${cs}`);
