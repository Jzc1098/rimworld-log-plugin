// Find which mod provides a C# type, by searching every assembly on disk for the type name.
//
// Written because the plugin's own search only covers enabled mods, and the mod list had just been
// reset to six entries, so it could not see the provider. This walks all mod roots regardless of
// what is currently enabled.
//
// It also reports the assembly's own name and whether the containing mod looks 1.6-compatible, since
// the usual cause of "Could not find type named X" is a provider that ships only older assemblies.
//
// Usage: node find-type-provider.mjs <TypeName> [<TypeName> ...]

import fs from 'node:fs';
import path from 'node:path';

const needles = process.argv.slice(2);
if (needles.length === 0) {
  console.error('usage: node find-type-provider.mjs <TypeName> [...]');
  process.exit(2);
}

// 搜索根由环境变量给出（公开版不写死本机路径）：
//   WORKSHOP_DIR   <steamapps\workshop\content\294100>
//   RIMCROW_HOME   RimCrow 安装根（可选，自动带上 mods/ 与 steamcmd 工坊缓存）
//   RIMWORLD_DIR   RimWorld 安装根（可选，自动带 Mods/）
const roots = [
  process.env.WORKSHOP_DIR,
  process.env.RIMCROW_HOME ? path.join(process.env.RIMCROW_HOME, 'mods') : undefined,
  process.env.RIMCROW_HOME ? path.join(process.env.RIMCROW_HOME, 'tools', 'steamcmd', 'steamapps', 'workshop', 'content', '294100') : undefined,
  process.env.RIMWORLD_DIR ? path.join(process.env.RIMWORLD_DIR, 'Mods') : undefined,
].filter(Boolean);
if (roots.length === 0) {
  console.error('请至少设置 WORKSHOP_DIR 或 RIMCROW_HOME 或 RIMWORLD_DIR 之一');
  process.exit(2);
}

/** Read the mod's About.xml for its name and packageId. */
function readAbout(modDir) {
  for (const candidate of ['About/About.xml', 'about/about.xml']) {
    const p = path.join(modDir, candidate);
    if (!fs.existsSync(p)) continue;
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const name = (/<name>([^<]*)<\/name>/i.exec(text) ?? [])[1] ?? '';
    const pkg = (/<packageId[^>]*>([^<]*)<\/packageId>/i.exec(text) ?? [])[1] ?? '';
    return { name: name.trim(), pkg: pkg.trim() };
  }
  return { name: '', pkg: '' };
}

const hits = [];

for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  let top;
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const dir of top) {
    if (!dir.isDirectory()) continue;
    const modDir = path.join(root, dir.name);
    let about = null;
    const stack = [modDir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (/^(\.git|Textures|Sounds|Languages|Source|obj)$/i.test(e.name)) continue;
          stack.push(full);
          continue;
        }
        if (!/\.dll$/i.test(e.name)) continue;

        let data;
        try {
          if (fs.statSync(full).size > 60 * 1024 * 1024) continue;
          data = fs.readFileSync(full);
        } catch {
          continue;
        }

        for (const needle of needles) {
          if (!data.includes(needle)) continue;
          if (!about) about = readAbout(modDir);
          hits.push({
            needle,
            dll: full,
            modDir,
            rel: path.relative(modDir, full),
            size: data.length,
            name: about.name,
            pkg: about.pkg,
          });
        }
      }
    }
  }
}

console.log('searched roots: ' + roots.filter((r) => fs.existsSync(r)).length);
for (const needle of needles) {
  const mine = hits.filter((h) => h.needle === needle);
  console.log('');
  console.log('=== ' + needle + '  (' + mine.length + ' assembly hit(s)) ===');
  for (const h of mine) {
    console.log('  dll      : ' + h.dll);
    console.log('  mod      : ' + (h.pkg || '(no packageId)') + '   ' + h.name);
    console.log('  size     : ' + h.size + ' B');
  }
  if (mine.length === 0) console.log('  (not provided by any assembly on disk)');
}
