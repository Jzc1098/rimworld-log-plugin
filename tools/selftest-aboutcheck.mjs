// Self-test for lib/aboutcheck.js（About.xml 校验）。
//
// 在临时目录里造四种 About.xml：合法、裸 &、description 含子元素、文件不存在。
// Usage: node tools/selftest-aboutcheck.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAbout, checkAboutXml } from '../lib/aboutcheck.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${ok ? String(actual) : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const checkTrue = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${detail}`);
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rimlog-aboutcheck-'));

function writeAbout(name, content) {
  const dir = path.join(tempDir, name);
  fs.mkdirSync(path.join(dir, 'About'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'About', 'About.xml'), content, 'utf8');
  return dir;
}

console.log('aboutcheck.js self-test');
console.log('');

// ---- 合法的 About.xml ----
console.log('合法文件：');
const good = writeAbout('good', `<?xml version="1.0" encoding="utf-8"?>
<ModMetaData>
  <name>Good Mod</name>
  <packageId>test.good</packageId>
  <modVersion>1.0.0</modVersion>
  <description>这是一个纯文本描述</description>
  <supportedVersions><li>1.6</li><li>1.7</li></supportedVersions>
</ModMetaData>
`);
const rGood = checkAbout(good);
check('ok = true', rGood.ok, true);
check('errors = 0', rGood.errors.length, 0);
check('packageId 提取', rGood.info.packageId, 'test.good');
check('name 提取', rGood.info.name, 'Good Mod');
check('modVersion 提取', rGood.info.modVersion, '1.0.0');
checkTrue('description 是纯文本', !rGood.errors.some((e) => e.includes('description')));

// ---- 裸 & ----
console.log('');
console.log('裸 &：');
const bare = writeAbout('bare', `<?xml version="1.0" encoding="utf-8"?>
<ModMetaData>
  <name>Bare Amp</name>
  <packageId>test.bare</packageId>
  <description>Tom & Jerry</description>
</ModMetaData>
`);
const rBare = checkAbout(bare);
check('ok = false', rBare.ok, false);
checkTrue('errors 包含裸 &', rBare.errors.some((e) => e.includes('裸 &')));
check('错误数 = 1', rBare.errors.length, 1);

// ---- description 含子元素 ----
console.log('');
console.log('description 含子元素：');
const elem = writeAbout('elem', `<?xml version="1.0" encoding="utf-8"?>
<ModMetaData>
  <name>Elem Desc</name>
  <packageId>test.elem</packageId>
  <description>文字开头 <b>加粗</b> 文字结尾</description>
</ModMetaData>
`);
const rElem = checkAbout(elem);
check('ok = false', rElem.ok, false);
checkTrue('errors 提到 description', rElem.errors.some((e) => e.includes('description')));

// ---- 文件不存在 ----
console.log('');
console.log('文件不存在：');
const rMissing = checkAbout(path.join(tempDir, 'nonexistent'));
check('ok = false', rMissing.ok, false);
check('exists = false', rMissing.exists, false);
checkTrue('errors 有提示', rMissing.errors.length > 0);

// ---- BOM ----
console.log('');
console.log('BOM：');
const bomFile = path.join(tempDir, 'bom', 'About', 'About.xml');
fs.mkdirSync(path.dirname(bomFile), { recursive: true });
fs.writeFileSync(bomFile, '\uFEFF<?xml version="1.0" encoding="utf-8"?>\n<ModMetaData>\n  <name>BOM</name>\n  <packageId>test.bom</packageId>\n</ModMetaData>\n', 'utf8');
const rBom = checkAbout(path.join(tempDir, 'bom'));
check('ok = true（BOM 只是警告）', rBom.ok, true);
checkTrue('warnings 提到 BOM', rBom.warnings.some((w) => w.includes('BOM')));

// ---- 直接传 XML 文件路径 ----
console.log('');
console.log('直接传 XML 路径：');
const rDirect = checkAboutXml(path.join(tempDir, 'good', 'About', 'About.xml'));
check('直接路径 ok = true', rDirect.ok, true);

// ---- 乱码字符 ----
console.log('');
console.log('乱码字符：');
fs.mkdirSync(path.join(tempDir, 'mojibake', 'About'), { recursive: true });
fs.writeFileSync(path.join(tempDir, 'mojibake', 'About', 'About.xml'),
  `<?xml version="1.0"?>\n<ModMetaData>\n  <name>Mojibake</name>\n  <packageId>test.moji</packageId>\n  <description>描述\uFFFD\uFFFD有乱码</description>\n</ModMetaData>\n`, 'utf8');
const rMoji = checkAbout(path.join(tempDir, 'mojibake'));
check('ok = true（乱码只是警告）', rMoji.ok, true);
checkTrue('warnings 提到替换字符', rMoji.warnings.some((w) => w.includes('替换字符')));

console.log('');
console.log('清理：');
fs.rmSync(tempDir, { recursive: true, force: true });
checkTrue('临时目录已删', !fs.existsSync(tempDir));

console.log('');
if (failures === 0) {
  console.log('全部通过。');
  process.exit(0);
}
console.log(`${failures} 项失败。`);
process.exit(1);
