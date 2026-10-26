/**
 * 插件的用户设置持久层。
 *
 * 为什么存在：此前所有可调项都是环境变量（`DSH_RIMWORLD_PATCH_DIR`、`RIMLOG_WORKSPACE_DIR`），
 * 普通用户根本设不了。本模块提供三级回退：**环境变量 > settings.json > 内置默认**——
 * 现有 env 用法零破坏，新用户直接改文件即可。
 *
 * 文件位置：`~/.dsh/rimworld-log/settings.json`（与 install-state.json 同目录），
 * 可用 `RIMLOG_STATE_DIR` 改址。模式照抄 `plugins/state.js`：错误一律降级为「用默认」，
 * 绝不让一个坏文件炸掉插件。
 *
 * 修改方式：用户让 agent 改文件（agent 写 `~/.dsh/rimworld-log/` 是插件自己的目录，
 * 不在 mod 红线内）；本模块只提供读，不提供写。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'rimworld-log.settings';
const SCHEMA_VERSION = 1;

/** 每个键的声明：环境变量名、类型、默认值。 */
const KEYS = {
  patchDir: {
    env: ['DSH_RIMWORLD_PATCH_DIR', 'RIMWORLD_PATCH_DIR'],
    type: 'string',
    default: () => path.join(os.homedir(), '.dsh', 'rimworld-log', 'patches'),
    label: '生成的补丁文件放在哪',
  },
  workspaceDir: {
    env: ['RIMLOG_WORKSPACE_DIR'],
    type: 'string',
    // 工厂返回 null：null 表示「本层不提供，由 workspace-archive.js 的探测链决定」。
    // 不能写成 default: null——falsy 的 default 会被 get() 的三元分支跳过，返回 undefined。
    default: () => null,
    label: '工作区目录（快照与归档的来源）',
  },
  snapshotDir: {
    env: ['RIMLOG_SNAPSHOT_DIR'],
    type: 'string',
    default: () => null,
    label: '快照目录',
  },
  ignoredSignatures: {
    env: [],
    type: 'string[]',
    default: () => [],
    label: '分析时跳过的已知噪音签名（子串匹配，大小写不敏感）',
  },
  clusterLimit: {
    env: [],
    type: 'number',
    default: () => 14,
    label: 'analyze 最多返回多少个问题簇',
  },
  defaultSource: {
    env: [],
    type: 'string',
    default: () => 'realtime',
    label: 'analyze 缺省日志来源',
  },
  language: {
    env: [],
    type: 'string',
    default: () => 'zh',
    label: '输出语言（预留；当前全部中文）',
  },
};

/** 设置文件路径。与 install-state.json 共享 `RIMLOG_STATE_DIR` 覆盖。 */
export function settingsPath() {
  const override = process.env.RIMLOG_STATE_DIR;
  return path.join(override || path.join(os.homedir(), '.dsh', 'rimworld-log'), 'settings.json');
}

/**
 * 读设置文件。读不到、格式不对、schema 不符都返回空对象（等于全用默认）。
 * 与 state.js 的 readState 同一套防御。
 */
function readSettings() {
  try {
    const file = settingsPath();
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    if (parsed.schema && parsed.schema !== SCHEMA) return {};
    return parsed;
  } catch {
    return {};
  }
}

const settingsCache = readSettings();

/**
 * 插件行配置（来自 cordis.patch.yml 的 `config:`，可经 DSH 设置界面编辑）。
 *
 * apply(ctx, config) 激活时调 setRowConfig 存进来；DSH 在配置被编辑后会重新激活插件，
 * 所以这里不需要监听变更——重新 apply 就会带上新值。
 */
let rowConfig = null;

/** 记录插件行配置；apply() 开头调用。传空/非对象等于清掉。 */
export function setRowConfig(row) {
  rowConfig = row && typeof row === 'object' ? row : null;
}

/**
 * 读一个键的生效值与来源。
 *
 * 优先级：**环境变量 > 配置界面（行配置）> settings.json > 内置默认**。
 * env 保持最高是 v1.6.6 起的契约（部署层覆盖不被 UI 意外压掉）；
 * 行配置坐在 settings.json 之上——两者语义相同（用户持久偏好），界面是新的入口。
 *
 * @param {string} key - KEYS 里声明的键名。
 * @returns {{value: any, origin: 'env'|'row'|'file'|'default', envVar?: string}}
 */
export function get(key) {
  const spec = KEYS[key];
  if (!spec) return { value: undefined, origin: 'default' };

  // 1. 环境变量
  for (const envVar of spec.env) {
    const raw = process.env[envVar];
    if (raw !== undefined && raw !== '') {
      return { value: coerce(raw, spec.type), origin: 'env', envVar };
    }
  }

  // 2. 配置界面（插件行配置）
  // volatile 字段在 harness 的 fork schemastery 里是「活引用」（{ get(), [write] }），
  // 公共 3.18.0 不包装，但这里解一次包：两种运行环境都能拿到普通值。
  let rowValue = rowConfig?.[key];
  if (rowValue && typeof rowValue === 'object' && typeof rowValue.get === 'function' && !Array.isArray(rowValue)) {
    try {
      rowValue = rowValue.get();
    } catch {
      /* 取不到就按未设置处理 */
    }
  }
  if (rowValue !== undefined && rowValue !== null && rowValue !== '') {
    return { value: coerce(rowValue, spec.type), origin: 'row' };
  }

  // 3. settings.json
  const fileValue = settingsCache[key];
  if (fileValue !== undefined && fileValue !== null) {
    return { value: coerce(fileValue, spec.type), origin: 'file' };
  }

  // 4. 内置默认
  return { value: spec.default ? spec.default() : undefined, origin: 'default' };
}

/**
 * 读全部键的生效值（不带来源标记）。
 *
 * @returns {object} 键 → 值 的映射。
 */
export function getAll() {
  const out = {};
  for (const key of Object.keys(KEYS)) {
    out[key] = get(key).value;
  }
  return out;
}

/**
 * 读全部键的生效值与来源（带标记，供 `action=config` 打印）。
 *
 * @returns {Array<{key: string, label: string, value: any, origin: string, envVar?: string}>}
 */
export function describeAll() {
  return Object.entries(KEYS).map(([key, spec]) => {
    const { value, origin, envVar } = get(key);
    return { key, label: spec.label, value, origin, envVar };
  });
}

/** 类型转换：字符串 → 目标类型。失败返回 undefined（等于回退到默认）。 */
function coerce(raw, type) {
  if (type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'string[]') {
    if (Array.isArray(raw)) return raw.map(String).filter((s) => s.trim() !== '');
    if (typeof raw === 'string') return raw.split(/[;,，；]/).map((s) => s.trim()).filter(Boolean);
    return undefined;
  }
  return String(raw);
}

/** 声明的键清单（自测用）。 */
export const KNOWN_KEYS = Object.keys(KEYS);

export { SCHEMA as SETTINGS_SCHEMA, SCHEMA_VERSION as SETTINGS_SCHEMA_VERSION };
