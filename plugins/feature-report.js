/**
 * Build the two texts the plugin reports about itself: a usage guide and a feature report.
 *
 * Both are generated from what is actually registered and what is actually on disk. Nothing here is
 * transcribed by hand, because a hand-written guide to a moving plugin is wrong within a week - the
 * manifest this project shipped described 55 files while the directory held 83.
 *
 * The feature report never says which copy of the plugin is newer. A version number is a claim a copy
 * makes about itself; it is printed, labelled as a claim, and used for nothing. What the report does say
 * is what changed, which is a fact about content.
 */

import { readState } from './state.js';
import {
  blockSummary, listCommands, listDocs, listToolScripts, listTools, listTopLevelDirs,
  pluginName, pluginVersion,
} from './registry.js';

/** Render one parameter's schema as a readable bullet. */
function describeParameter(name, schema) {
  const bits = [];
  const type = schema?.type ?? 'any';
  bits.push(`\`${name}\` (${type})`);
  if (schema?.description) bits.push(schema.description);
  if (Array.isArray(schema?.enum) && schema.enum.length) {
    bits.push(`可选：${schema.enum.map((v) => `\`${v}\``).join(' | ')}`);
  }
  if (Array.isArray(schema?.items?.enum) && schema.items.enum.length) {
    bits.push(`元素可选：${schema.items.enum.map((v) => `\`${v}\``).join(' | ')}`);
  }
  if (type === 'array') bits.push('（数组，可传多个）');
  return bits.join(' —— ');
}

/**
 * The usage guide.
 *
 * Tool parameters come from the same schema the model is given, so this cannot drift from the tools it
 * describes: change a parameter's description and the guide changes with it.
 */
export function usageText() {
  const lines = [];
  const tools = listTools();
  const commands = listCommands();

  lines.push('# 用法说明');
  lines.push('');
  lines.push('本文件由插件从**注册表**生成，不是手写的 —— 所以它不会与工具的实际参数脱节。');
  lines.push('');

  lines.push(`## 工具（${tools.length} 个）`);
  lines.push('');
  if (!tools.length) {
    lines.push('（尚未注册 —— 插件可能未加载完成）');
    lines.push('');
  }
  for (const tool of tools) {
    lines.push(`### \`${tool.name}\``);
    lines.push('');
    if (tool.description) {
      lines.push(tool.description);
      lines.push('');
    }
    const props = tool.parameters?.properties ?? {};
    const names = Object.keys(props);
    if (names.length) {
      lines.push('参数：');
      lines.push('');
      for (const name of names) {
        lines.push(`- ${describeParameter(name, props[name])}`);
      }
      lines.push('');
    } else {
      lines.push('无参数。');
      lines.push('');
    }
  }

  lines.push(`## 命令（${commands.length} 个）`);
  lines.push('');
  if (!commands.length) {
    lines.push('（尚未注册）');
    lines.push('');
  }
  for (const command of commands) {
    lines.push(`### \`/${command.name}\``);
    lines.push('');
    if (command.description) lines.push(command.description);
    if (command.input?.hint) {
      lines.push('');
      lines.push('用法：');
      lines.push('');
      lines.push('```');
      lines.push(`/${command.name} ${command.input.hint}`);
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * A one-paragraph orientation appended to the install notice, so the reader is told what exists without
 * having to open the full guide.
 */
export function usageSummary() {
  const tools = listTools();
  const commands = listCommands();
  const lines = [];
  if (tools.length) {
    lines.push(`- 工具：${tools.map((t) => '`' + t.name + '`').join('、')}`);
  }
  if (commands.length) {
    lines.push(`- 命令：${commands.map((c) => '`/' + c.name + '`').join('、')}`);
  }
  lines.push('- 完整用法说明（含每个参数的取值）：`rimworld_plugin_guide` `action=usage`');
  return lines.join('\n');
}

/**
 * The feature report.
 *
 * `since` is a version string recorded previously, or null for a first run. It is used only to decide
 * which heading to print; the delta itself comes from comparing recorded tool names and block counts,
 * because those are facts about content.
 */
export function reportText(since = null) {
  const state = readState();
  const version = pluginVersion();
  const name = pluginName();
  const blocks = blockSummary();
  const tools = listTools();
  const commands = listCommands();
  const scripts = listToolScripts();
  const docs = listDocs();
  const dirs = listTopLevelDirs();

  const lines = [];
  lines.push('# 插件功能报告');
  lines.push('');
  lines.push('> **本报告不判断版本新旧。** 版本号是各方对自己做的声明，这里只原样记录，');
  lines.push('> 不用于任何判断。下面的内容全部来自实际文件与注册表。');
  lines.push('');

  lines.push('## 一、基本事实');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 包名 | \`${name ?? '(未声明)'}\` |`);
  lines.push(`| 声明版本 | \`${version ?? '(未声明)'}\`（仅记录） |`);
  lines.push(`| 工具 | ${tools.length} 个 |`);
  lines.push(`| 命令 | ${commands.length} 个 |`);
  lines.push(`| 工具脚本 | ${scripts.length} 个 |`);
  lines.push(`| 文档 | ${docs.length} 份 |`);
  lines.push(`| 目录 | ${dirs.join('、') || '—'} |`);
  lines.push('');

  lines.push('## 二、块清单');
  lines.push('');
  if (!blocks.present) {
    lines.push('**本副本没有 `blocks.json`** —— 没有块级登记表，因此无法给出块清单与作者信息。');
    lines.push('生成方式：`node tools/stamp-blocks.mjs`');
    lines.push('');
  } else {
    lines.push(`共 **${blocks.total}** 个块。`);
    lines.push('');
    lines.push('| 块类型 | 数量 |');
    lines.push('|---|---|');
    for (const [kind, count] of Object.entries(blocks.byKind).sort((a, b) => b[1] - a[1])) {
      lines.push(`| \`${kind}\` | ${count} |`);
    }
    lines.push('');
    lines.push(`- **有作者署名的块：${blocks.named}**`);
    lines.push(`- **基线块（早于登记表，作者未知）：${blocks.baseline}**`);
    lines.push('');
    if (blocks.baseline > 0 && blocks.named === 0) {
      lines.push('> 全部是基线块：登记表是在这些块写完之后才建立的，所以没有署名。');
      lines.push('> 这不是缺失 —— 是事实。此后新增或改动的块会自动获得署名，');
      lines.push('> 想给某个基线块补署名用 `node tools/stamp-blocks.mjs --adopt`。');
      lines.push('');
    }
  }

  lines.push('## 三、作者');
  lines.push('');
  if (!blocks.present || Object.keys(blocks.authors ?? {}).length === 0) {
    lines.push('（还没有任何块被署名 —— 所有现存块都早于登记表）');
    lines.push('');
  } else {
    lines.push('| 作者 | 涉及块数 | 首次出现 |');
    lines.push('|---|---|---|');
    for (const [id, entry] of Object.entries(blocks.authors)) {
      lines.push(`| \`${id}\`${entry.display && entry.display !== id ? `（${entry.display}）` : ''}`
        + ` | ${entry.blocks} | ${entry.firstSeen ?? '—'} |`);
    }
    lines.push('');
  }

  lines.push('## 四、自上次记录以来的变化');
  lines.push('');
  const previousTools = Array.isArray(state.toolNames) ? state.toolNames : null;
  const previousVersion = state.version ?? null;
  const previousBlockCount = Number.isFinite(state.blockCount) ? state.blockCount : null;

  if (!previousVersion && !previousTools) {
    lines.push('**没有找到上次的记录 —— 这看起来是第一次运行。**');
    lines.push('');
    lines.push('已记录当前状态：下次启动时这里会显示工具与块的增减。');
    lines.push('');
  } else {
    lines.push(`上次记录的声明版本：\`${previousVersion ?? '(无)'}\`（当前 \`${version ?? '(无)'}\`，仅记录）`);
    lines.push('');
    if (previousTools) {
      const added = tools.map((t) => t.name).filter((n) => !previousTools.includes(n));
      const removed = previousTools.filter((n) => !tools.map((t) => t.name).includes(n));
      if (!added.length && !removed.length) {
        lines.push('- **工具：没有增减**');
      } else {
        if (added.length) lines.push(`- **新增工具**：${added.map((n) => '`' + n + '`').join('、')}`);
        if (removed.length) lines.push(`- **移除的工具**：${removed.map((n) => '`' + n + '`').join('、')}`);
      }
    }
    if (previousBlockCount !== null && blocks.present) {
      const delta = blocks.total - previousBlockCount;
      lines.push(`- **块数**：${previousBlockCount} → ${blocks.total}（${delta >= 0 ? '+' : ''}${delta}）`);
    }
    lines.push('');
  }

  lines.push('## 五、工具与命令');
  lines.push('');
  if (!tools.length && !commands.length) {
    lines.push('（尚未注册）');
    lines.push('');
  } else {
    for (const tool of tools) {
      lines.push(`- \`${tool.name}\` —— ${(tool.description ?? '').split('。')[0]}。`);
    }
    for (const command of commands) {
      lines.push(`- \`/${command.name}\` —— ${command.description ?? ''}`);
    }
    lines.push('');
  }

  lines.push('## 六、工具脚本与文档');
  lines.push('');
  lines.push(`**工具脚本 ${scripts.length} 个**（\`tools/\`）：`);
  lines.push('');
  lines.push(scripts.map((s) => '`' + s.replace(/^tools\//, '') + '`').join('、') || '（无）');
  lines.push('');
  lines.push(`**文档 ${docs.length} 份**（根目录）：`);
  lines.push('');
  for (const doc of docs) lines.push(`- \`${doc}\``);
  lines.push('');
  lines.push('各脚本的用途见 `OPERATIONS.md` 第 7 节。');
  lines.push('');

  lines.push('## 七、关于比对与合并');
  lines.push('');
  lines.push('要拿到别人改过的副本里有什么，用工具脚本比对（只比清单，不判先后）：');
  lines.push('');
  lines.push('```');
  lines.push('node tools/compare-plugin.mjs <对方的插件目录>');
  lines.push('```');
  lines.push('');
  lines.push('报告会分节列出「对方有而我没有」「两边都有但不同」「疑似同功能」以及**按导入安全性排序**的清单。');
  lines.push('要合并其中的块，用 `node tools/import-blocks.mjs <对方目录> --blocks <块 id>` —— ');
  lines.push('**默认只生成 staging 目录，不写入插件本体。**');
  lines.push('');

  return lines.join('\n');
}

/**
 * The notice injected into the system prompt when the declared version differs from the last recorded one.
 *
 * Returns an empty string when nothing changed, so a steady-state session pays nothing for this feature.
 * The notice states the two version strings as facts and draws no conclusion from them.
 */
export function installNotice() {
  const state = readState();
  const version = pluginVersion();
  const previous = state.version ?? null;

  // No record at all: a first run. Report once, then stay quiet.
  if (!previous) {
    return [
      '## 插件状态：首次记录',
      '',
      'RimCrow 日志分析插件（`@local/rimworld-log`）已记录当前状态。',
      `声明版本：\`${version ?? '(未声明)'}\`（仅记录，不参与判断）`,
      '',
      usageSummary(),
      '',
      '想要完整功能清单：`rimworld_plugin_guide` `action=report`。',
    ].join('\n');
  }

  if (previous === version) return '';

  return [
    '## 插件状态：声明版本与上次记录不同',
    '',
    `上次记录 \`${previous}\` → 当前 \`${version}\`（**两个都只是声明值，本提示不据此判断谁更新**）`,
    '',
    usageSummary(),
    '',
    '变化详情：`rimworld_plugin_guide` `action=since`。',
  ].join('\n');
}
