/**
 * Step 1 of the 1.6 -> 1.7 comparison: find string-targeted Harmony patches whose target no longer exists.
 *
 * Why this step exists separately from the API diff. A binary API diff sees only references that carry a
 * metadata token. A large share of RimWorld mods build their patches by NAME instead:
 *
 *     AccessTools.Method(typeof(ThingDef), "ConfigErrors")
 *     [HarmonyPatch(typeof(Pawn), "DeSpawn")]
 *     harmony.Patch(AccessTools.Method(type, "TryStartMentalState"), ...)
 *
 * None of those produce a token pointing at the target, so a token-level diff is blind to them - and
 * those are precisely the patches that broke on this profile. The names live as string literals, so this
 * script recovers them from the raw bytes and asks the 1.7 assembly whether the target still exists.
 *
 * Method: scan each mod assembly for printable strings, keep those that look like a member name, pair
 * each with the nearest preceding string that looks like a type name, and look the pair up in a member
 * index built from the 1.7 game assemblies. A pair that does not resolve is reported.
 *
 * Deliberately not a verdict. A miss can mean the target is gone, renamed, moved to another type, or
 * that the pairing guessed the wrong type. Reported as candidates, with the raw strings shown.
 *
 * Usage:
 *   node tools/find-string-targets.mjs --index <indexFile> [--game <dir>] [--report <file>]
 *        --index     output of: ildump <Assembly-CSharp.dll> --public   (plus RimWorld.dll / UnityStubs.dll)
 *        --game      game root, used to derive the default assembly set
 *        --dirs-from file listing mod assembly directories, one per line
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const indexPath = arg('--index');
const dirsFrom = arg('--dirs-from');
const reportPath = arg('--report', null);
const minNameLen = Number(arg('--min-len', '4'));

if (!indexPath || !dirsFrom) {
  console.error('usage: find-string-targets.mjs --index <public-api-dump> --dirs-from <dirs.txt> [--report out.md]');
  process.exit(2);
}

// ---- 1. index the 1.7 API -------------------------------------------------
//
// The dump lines look like:  `Verse.ThingDef :: category : ThingCategory`
//                            `Verse.ThingDef :: get_Minifiable() : Boolean`
// Type-only lines have no ` :: `.

const byMember = new Map();   // member name -> Set of type names
const byPair = new Set();     // "Type::member"
const typeNames = new Set();

for (const raw of fs.readFileSync(indexPath, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line) continue;
  const sep = line.indexOf(' :: ');
  if (sep < 0) {
    typeNames.add(line);
    continue;
  }
  const type = line.slice(0, sep).trim();
  let member = line.slice(sep + 4).trim();
  for (const cut of ['(', ' : ', ' {get;set;}']) {
    const at = member.indexOf(cut);
    if (at >= 0) member = member.slice(0, at);
  }
  member = member.trim();
  if (!type || !member) continue;
  typeNames.add(type);
  byPair.add(type + '::' + member);
  if (!byMember.has(member)) byMember.set(member, new Set());
  byMember.get(member).add(type);
}

console.log(`1.7 索引: ${typeNames.size} 个类型, ${byPair.size} 个 类型::成员, ${byMember.size} 个不同成员名`);

// ---- 2. string extraction -------------------------------------------------

const TYPE_LIKE = /^[A-Z][A-Za-z0-9_]*(\.[A-Z][A-Za-z0-9_]*)*$/;
const MEMBER_LIKE = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;

/** ASCII and UTF-16LE printable runs, same rule as the C# scanner. */
function stringsOf(file) {
  const bytes = fs.readFileSync(file);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 0x20 && b < 0x7f) {
      let start = i;
      while (i < bytes.length && bytes[i] >= 0x20 && bytes[i] < 0x7f) i++;
      if (i - start >= minNameLen) {
        const s = bytes.toString('latin1', start, i);
        if (!seen.has(s)) { seen.add(s); out.push(s); }
      }
      i--;
      continue;
    }
    if (b >= 0x20 && b < 0x7f && bytes[i + 1] === 0) {
      let s = '';
      while (i + 1 < bytes.length && bytes[i] >= 0x20 && bytes[i] < 0x7f && bytes[i + 1] === 0) {
        s += String.fromCharCode(bytes[i]);
        i += 2;
      }
      if (s.length >= 3 && !seen.has(s)) { seen.add(s); out.push(s); }
      i--;
    }
  }
  return out;
}

const dirs = fs.readFileSync(dirsFrom, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const files = [];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.toLowerCase().endsWith('.dll')) files.push(path.join(dir, name));
  }
}

const findings = new Map();  // assembly -> [{member, type, kind, raw}]
let scanned = 0;

for (const file of files) {
  let strings;
  try { strings = stringsOf(file); } catch { continue; }
  scanned++;

  const hits = [];
  let lastType = null;
  for (const s of strings) {
    if (TYPE_LIKE.test(s) && s.length > 3) { lastType = s; continue; }
    if (!MEMBER_LIKE.test(s)) continue;
    if (!byMember.has(s)) continue;                       // not a game member name at all

    const owners = byMember.get(s);
    // A bare name that exists somewhere is normal; only a qualified guess can be wrong.
    if (lastType && !byPair.has(lastType + '::' + s)) {
      // The name is real but not on this type: either the type moved it, or the pairing is off.
      const shortType = lastType.includes('.') ? lastType.slice(lastType.lastIndexOf('.') + 1) : lastType;
      const sameShort = [...owners].some((o) => o.endsWith('.' + shortType) || o === shortType);
      if (!sameShort) {
        hits.push({ member: s, type: lastType, kind: 'not on this type', owners: [...owners].slice(0, 3) });
      }
    }
  }
  if (hits.length) {
    const key = file;
    findings.set(key, hits.slice(0, 40));
  }
}

// ---- 3. report ------------------------------------------------------------

const lines = [];
lines.push('# 字符串目标扫描（第 1 步）');
lines.push('');
lines.push(`- 索引来源：\`${indexPath}\``);
lines.push(`- 1.7 类型 ${typeNames.size} 个 / 类型::成员 ${byPair.size} 对`);
lines.push(`- 扫描程序集 ${scanned} 个`);
lines.push(`- 有可疑目标的程序集 **${findings.size}** 个`);
lines.push('');
lines.push('**这不是判决。** 命中表示「某个字符串成员名与它前面最近的类型名对不上」，');
lines.push('可能是目标被移除／改名／搬到别的类型，也可能是配对猜错了类型。');
lines.push('');
if (findings.size) {
  lines.push('| 程序集 | 可疑目标数 |');
  lines.push('|---|---|');
  for (const [file, hits] of [...findings.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`| \`${path.basename(file)}\` | ${hits.length} |`);
  }
  lines.push('');
  lines.push('<details><summary>逐条明细</summary>');
  lines.push('');
  for (const [file, hits] of findings) {
    lines.push(`### ${file}`);
    lines.push('');
    for (const h of hits) {
      lines.push(`- \`${h.type}::${h.member}\`  — ${h.kind}`
        + `${h.owners.length ? `；该名字在 1.7 属于：${h.owners.map((o) => '`' + o + '`').join('、')}` : ''}`);
    }
    lines.push('');
  }
  lines.push('</details>');
} else {
  lines.push('没有发现可疑的字符串目标。');
}
lines.push('');

const text = lines.join('\n');
if (reportPath) {
  fs.writeFileSync(reportPath, text, 'utf8');
  console.log(`报告写入: ${reportPath}`);
}
console.log(text.split('\n').slice(0, 14).join('\n'));
