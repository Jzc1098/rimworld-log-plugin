/**
 * 补丁部署审计：启用中的修复 mod，工作区源码与部署目录是否一致。
 *
 * 背景：修复 mod 的工作区目录（如 `fix-vf-tickhandlers`）和游戏 Mods 里的部署目录
 * （如 `Fix - VF vehicle tick broken by crew change`）**目录名完全对不上**——唯一可靠的
 * 对应键是 About.xml 里的 `packageId`。实际场景里这个对比我手工做了 8+ 次
 * （每次部署后「哈希一致?」），全是同一套逻辑：找对应 → 比 DLL → 比时间。
 *
 * 判定规则（只读，不碰任何文件）：
 *  - `synced`：两边同名 DLL 哈希一致，且源码没有比部署更新的
 *  - `source-newer`：工作区最新 .cs 的 mtime > 部署 DLL 的 mtime（改了源码还没部署）
 *  - `hash-mismatch`：同名 DLL 哈希不同（部署的不是最新构建）
 *  - `no-workspace`：部署的 mod 没有工作区副本（companion、debug 探针——正常，计数）
 *  - `not-enabled`：工作区有但没启用（`fix-axolotl-ce-melee` 这种主动停用的——正常，计数）
 *
 * 所有操作都是 stat + readFileSync（About.xml）+ createHash，绝无写入。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 审计的前缀：默认只管 `rimcrow.*`（本工作区产出的修复 mod 约定）。 */
const DEFAULT_PREFIX = 'rimcrow.';

/** DLL 搜索时跳过的目录名（部署目录里的 backup-* 是 deploy-fix.ps1 的产物）。 */
const SKIP_DIRS = new Set(['backup', 'node_modules', '.git', 'Source']);

/** 每个状态分区最多列几条，防止一次输出几百行。 */
const LIST_LIMIT = 20;

/**
 * 读一个 mod 目录的 About.xml 身份（轻量版：只要 packageId 与 name）。
 *
 * 不复用 detect.js 的 readAbout 是刻意的：那个函数处理 modDependencies 剔除等复杂逻辑，
 * 这里只需要根级字段；独立维护避免审计被动跟随探测器的变更。
 */
function readIdentity(modDir) {
  for (const rel of [path.join('About', 'About.xml'), path.join('About', 'about.xml')]) {
    try {
      const xml = fs.readFileSync(path.join(modDir, rel), 'utf8').replace(/^\uFEFF/, '');
      const id = /<packageId\b[^>]*>([^<]*)<\/packageId\s*>/i.exec(xml);
      const name = /<name\b[^>]*>([^<]*)<\/name\s*>/i.exec(xml);
      if (id) {
        return { packageId: id[1].trim(), name: name ? name[1].trim() : path.basename(modDir), dir: modDir };
      }
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** 递归找 DLL 文件（跳过 backup / Source / .git），返回 basename → 绝对路径 的映射。 */
function findDlls(root) {
  const found = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('backup-') || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.dll$/i.test(entry.name)) {
        if (!found.has(entry.name)) found.set(entry.name, full);
      }
    }
  };
  walk(root);
  return found;
}

/** 找目录下最新的 .cs 文件 mtime（含 Source/；不含备份）。 */
function newestSourceMtime(root) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('backup-') || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.cs$/i.test(entry.name)) {
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime > newest) newest = mtime;
        } catch {
          /* stat 失败不算错误 */
        }
      }
    }
  };
  walk(root);
  return newest;
}

function hashFile(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * 审计启用中的修复 mod 的部署状态。
 *
 * @param {Array<{packageId: string, dir?: string, name?: string, installed?: boolean}>} activeMods
 *   detect 侧已解析的启用列表。
 * @param {object} [options]
 * @param {string} [options.workspaceDir] - 工作区根；缺省时由调用方传入。
 * @param {string} [options.prefix] - 审计的 packageId 前缀，默认 `rimcrow.`。
 * @returns 审计结果。
 */
export function patchAudit(activeMods, options = {}) {
  const workspaceDir = options.workspaceDir;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  if (!workspaceDir || !fs.existsSync(workspaceDir)) {
    return { ok: false, error: `工作区目录不存在或未指定: ${workspaceDir ?? '(null)'}` };
  }

  // ---- 工作区侧索引：packageId → 目录 ----
  const workspaceByPackageId = new Map();
  let workspaceScanned = 0;
  let workspaceNoAbout = 0;
  try {
    for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      workspaceScanned += 1;
      const identity = readIdentity(path.join(workspaceDir, entry.name));
      if (identity) {
        if (!workspaceByPackageId.has(identity.packageId)) {
          workspaceByPackageId.set(identity.packageId, identity);
        }
      } else {
        workspaceNoAbout += 1;
      }
    }
  } catch (e) {
    return { ok: false, error: `工作区扫描失败: ${e?.message ?? e}` };
  }

  // ---- 部署侧：启用中的 rimcrow.* ----
  const deployed = (activeMods ?? [])
    .filter((m) => m?.packageId && m.packageId.toLowerCase().startsWith(prefix))
    .map((m) => ({ packageId: m.packageId, dir: m.dir, name: m.name, installed: m.installed !== false }));

  const synced = [];
  const sourceNewer = [];
  const hashMismatch = [];
  const noWorkspace = [];
  const noDll = [];

  for (const mod of deployed) {
    if (!mod.installed || !mod.dir || !fs.existsSync(mod.dir)) {
      noWorkspace.push({ ...mod, reason: mod.installed ? '目录不存在' : '标记为未安装' });
      continue;
    }
    const ws = workspaceByPackageId.get(mod.packageId);
    if (!ws) {
      noWorkspace.push({ ...mod, reason: '无工作区副本' });
      continue;
    }

    const deployedDlls = findDlls(mod.dir);
    const workspaceDlls = findDlls(ws.dir);

    if (deployedDlls.size === 0 && workspaceDlls.size === 0) {
      noDll.push({ ...mod, workspaceDir: ws.dir, note: '两边都没有 DLL（纯 XML 补丁，正常）' });
      continue;
    }

    const row = { packageId: mod.packageId, name: mod.name, deployedDir: mod.dir, workspaceDir: ws.dir };

    // 哈希比同名 DLL
    let mismatch = false;
    const dllStatus = [];
    for (const [name, deployedFile] of deployedDlls) {
      const workspaceFile = workspaceDlls.get(name);
      if (!workspaceFile) {
        dllStatus.push({ dll: name, status: 'only-deployed' });
        continue;
      }
      const a = hashFile(deployedFile);
      const b = hashFile(workspaceFile);
      if (a !== b) {
        mismatch = true;
        dllStatus.push({ dll: name, status: 'hash-mismatch' });
      } else {
        dllStatus.push({ dll: name, status: 'match' });
      }
    }
    for (const name of workspaceDlls.keys()) {
      if (!deployedDlls.has(name)) dllStatus.push({ dll: name, status: 'only-workspace' });
    }

    // 源码时间 vs 部署时间
    const sourceMtime = newestSourceMtime(ws.dir);
    let deployedMtime = 0;
    for (const file of deployedDlls.values()) {
      try {
        const m = fs.statSync(file).mtimeMs;
        if (m > deployedMtime) deployedMtime = m;
      } catch {
        /* skip */
      }
    }

    if (mismatch) {
      hashMismatch.push({ ...row, dllStatus: dllStatus.filter((d) => d.status !== 'match') });
    } else if (sourceMtime > deployedMtime && sourceMtime > 0) {
      sourceNewer.push({
        ...row,
        sourceMtime: new Date(sourceMtime).toISOString(),
        deployedMtime: deployedMtime > 0 ? new Date(deployedMtime).toISOString() : undefined,
      });
    } else {
      synced.push(row);
    }
  }

  // ---- 工作区有但未启用 ----
  const deployedIds = new Set(deployed.map((m) => m.packageId));
  const notEnabled = [];
  for (const [packageId, identity] of workspaceByPackageId) {
    if (packageId.toLowerCase().startsWith(prefix) && !deployedIds.has(packageId)) {
      notEnabled.push({ packageId, name: identity.name, dir: identity.dir });
    }
  }

  return {
    ok: true,
    prefix,
    workspaceDir: path.resolve(workspaceDir),
    workspace: { scanned: workspaceScanned, withAbout: workspaceByPackageId.size, noAbout: workspaceNoAbout },
    counts: {
      deployed: deployed.length,
      synced: synced.length,
      sourceNewer: sourceNewer.length,
      hashMismatch: hashMismatch.length,
      noWorkspace: noWorkspace.length,
      noDll: noDll.length,
      notEnabled: notEnabled.length,
    },
    synced: synced.slice(0, LIST_LIMIT),
    sourceNewer: sourceNewer.slice(0, LIST_LIMIT),
    hashMismatch: hashMismatch.slice(0, LIST_LIMIT),
    noWorkspace: noWorkspace.slice(0, LIST_LIMIT),
    noDll: noDll.slice(0, LIST_LIMIT),
    notEnabled: notEnabled.slice(0, LIST_LIMIT),
    verdict: sourceNewer.length === 0 && hashMismatch.length === 0
      ? `全部 ${synced.length} 个部署中的 ${prefix}* 补丁与工作区一致`
      : `${sourceNewer.length} 个源码比部署新、${hashMismatch.length} 个哈希不一致`,
  };
}
