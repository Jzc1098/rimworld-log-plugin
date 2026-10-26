/**
 * About.xml 校验：XML 可解析、裸 `&` 扫描、description 类型、编码嗅探。
 *
 * 来源是 PATCHES.md 的手工检查清单（同一套规则被踩了 5+ 次后固化）：
 *  - 裸 `&` 会让 XML 在加载时才报错
 *  - description 变成 XmlElement 时**部分文字静默丢失**且不报错
 *  - BOM / 乱码字符说明编码出了问题
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 校验一个 About.xml 文件。
 *
 * @param {string} filePath - About.xml 的绝对路径。
 * @returns 校验结果。
 */
export function checkAboutXml(filePath) {
  const result = {
    file: filePath,
    exists: true,
    errors: [],
    warnings: [],
    info: {},
  };

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ...result, exists: false, errors: ['文件不存在或不可读'] };
  }

  // ---- 1. BOM 检查 ----
  const hasBom = text.charCodeAt(0) === 0xFEFF;
  if (hasBom) {
    result.warnings.push('文件带 UTF-8 BOM；RimWorld 能读但不保证所有工具都正确处理，建议去掉');
  }

  const stripped = hasBom ? text.slice(1) : text;

  // ---- 2. 裸 & 扫描 ----
  const lines = stripped.split('\n');
  const bareAmp = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g)) {
      bareAmp.push(`L${i + 1}: ${lines[i].trim().slice(0, 80)}`);
    }
  }
  if (bareAmp.length > 0) {
    result.errors.push(`裸 & 出现 ${bareAmp.length} 处（会在加载时才报错）：${bareAmp.slice(0, 3).join('；')}`);
  }

  // ---- 3. XML 可解析 ----
  let parsed = null;
  try {
    // Node 没有内置 XML 解析器，但可以用正则做结构检查：标签配对。
    // 真正的解析在加载时由游戏完成；这里只做「明显的坏」检测。
    const opens = (stripped.match(/<[A-Za-z][^>]*[^/]>/g) ?? []).length;
    const closes = (stripped.match(/<\/[A-Za-z][^>]*>/g) ?? []).length;
    const selfs = (stripped.match(/<[A-Za-z][^>]*\/>/g) ?? []).length;
    // opens 包含了 self-closing（因为没有排除 />），所以有效 opens = opens - selfs
    const effectiveOpens = opens - selfs;
    if (effectiveOpens !== closes) {
      result.warnings.push(`标签可能不配对：开 ${effectiveOpens} 个、闭 ${closes} 个（可能因 CDATA 或嵌套导致误报）`);
    }
    result.info.tagBalance = { opens: effectiveOpens, closes, selfs };
  } catch (e) {
    result.errors.push(`结构检查失败: ${e?.message ?? e}`);
  }

  // ---- 4. description 类型 ----
  // 如果 description 的内容包含 < 或 >，说明它可能变成了 XmlElement 而不是纯文本。
  const descMatch = /<description\b[^>]*>([\s\S]*?)<\/description\s*>/i.exec(stripped);
  if (descMatch) {
    const content = descMatch[1].trim();
    const hasChildElements = /<[A-Za-z]/.test(content);
    if (hasChildElements) {
      result.errors.push('description 含子元素（XmlElement），部分文字会静默丢失；应为纯文本');
    }
    result.info.descriptionLength = content.length;
  } else {
    result.info.descriptionPresent = false;
  }

  // ---- 5. 乱码字符 ----
  const replacement = (stripped.match(/\uFFFD/g) ?? []).length;
  if (replacement > 0) {
    result.warnings.push(`含 ${replacement} 个替换字符（U+FFFD），编码可能有问题`);
  }

  // ---- 6. 基本字段 ----
  const packageId = /<packageId\b[^>]*>([^<]*)<\/packageId\s*>/i.exec(stripped);
  const name = /<name\b[^>]*>([^<]*)<\/name\s*>/i.exec(stripped);
  const modVersion = /<modVersion\b[^>]*>([^<]*)<\/modVersion\s*>/i.exec(stripped);
  result.info = {
    ...result.info,
    packageId: packageId ? packageId[1].trim() : '(missing)',
    name: name ? name[1].trim() : '(missing)',
    modVersion: modVersion ? modVersion[1].trim() : undefined,
  };

  result.ok = result.errors.length === 0;
  return result;
}

/**
 * 校验一个目录里的 About.xml（或目录本身是 mod 目录时找它的 About）。
 *
 * @param {string} dirOrFile - About.xml 文件路径，或包含它的 mod 目录。
 * @returns 校验结果。
 */
export function checkAbout(dirOrFile) {
  let file = dirOrFile;

  // 如果传的是目录，找 About/About.xml
  try {
    if (fs.statSync(dirOrFile).isDirectory()) {
      for (const rel of [path.join('About', 'About.xml'), path.join('About', 'about.xml'), 'About.xml']) {
        const candidate = path.join(dirOrFile, rel);
        if (fs.existsSync(candidate)) {
          file = candidate;
          break;
        }
      }
    }
  } catch {
    // 不是目录也不是文件
  }

  if (!file.endsWith('.xml')) {
    return { ok: false, file, exists: false, errors: [`不是 XML 文件: ${file}`], warnings: [], info: {} };
  }

  return checkAboutXml(file);
}
