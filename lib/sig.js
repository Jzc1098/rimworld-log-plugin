/**
 * 签名与归属的「消费侧」共享层。
 *
 * 为什么存在：`analyze()` 已经把归一化和归属做完（`cluster.normalized` / `cluster.attributedMod`），
 * 紧凑视图（`compact=true`）与会话对比（`action=diff`）都只是同一份结果的两种**消费方式**，
 * 不该各自再写一遍规则。本模块不解析日志、不读文件——只接收 analysis 结果。
 *
 * 设计约束：
 *  - 输入永远是 `analyze()` 的返回形状（见 lib/report.js 的 analysis 构造），这样两处视图
 *    与详细报告**不可能**对同一条目给出不同的签名或归属；
 *  - 所有函数纯同步、无 IO，selftest 可以离线跑；
 *  - 「引擎/未归属」折叠只发生在本模块的视图里；详细报告（analyze 默认输出）原样保留每条归属。
 */

/** 折叠桶的标签：表示「这条要么没归属到 mod，要么归属只是路径线索/不在启用列表」。 */
export const ENGINE_BUCKET = '引擎/未归属';

/**
 * 归一化签名的展示长度。`cluster.normalized` 本身可能较长（clusterProblems 的归一化规则），
 * 紧凑视图只需要能认出是哪一条，90 字符足够（与旧版手工归类脚本的截断一致）。
 */
const SIGNATURE_SLICE = 90;

/**
 * 判定一个簇的归属桶。
 *
 * 折叠进「引擎/未归属」的三种情况，全部来自实测噪声形态：
 *  1. `attributedMod` 为空 —— 堆栈只含引擎帧，或编译期路径无 mod 线索；
 *  2. `confidence === 'low'`（仅路径线索）—— 归属本身是猜的；
 *  3. `enabled === false`（不在启用列表）—— 实测 `InvokeMessageMethod_Verse ×78`
 *     和 `GodHandMod`（PA's God Hands 的调用帧）都属于这类：名字像 mod，但对应的
 *     程序集并不来自任何启用 mod。
 *
 * @param {object} cluster - analyze() 返回的单个簇。
 * @returns {{engine: boolean, label: string}}
 */
export function attributionBucket(cluster) {
  const mod = cluster?.attributedMod;
  if (!mod || mod.confidence === 'low' || mod.enabled === false) {
    return { engine: true, label: ENGINE_BUCKET };
  }
  return { engine: false, label: mod.packageId ? `${mod.name} [${mod.packageId}]` : String(mod.name) };
}

/**
 * 紧凑视图的一行。
 *
 * @param {object} cluster - 单个簇。
 * @returns {{count: number, sig: string, mod: string, engine: boolean}}
 */
export function signatureLine(cluster) {
  const bucket = attributionBucket(cluster);
  const sig = String(cluster.normalized ?? cluster.samples?.[0] ?? '').slice(0, SIGNATURE_SLICE);
  return { count: cluster.occurrences, sig, mod: bucket.label, engine: bucket.engine };
}

/**
 * 忽略清单命中判定：子串匹配（大小写不敏感），对签名与样本都试一次。
 *
 * 用途是把「已知的故意噪音」挡在视图外——最典型的是 PA's God Hands 每次启动都保留的那条
 * 红字，它长期霸占问题簇第 1 名，而用户每次都要回答「这是正常的」。
 *
 * @param {object} cluster - 单个簇。
 * @param {string[]} ignore - 忽略子串列表。
 * @returns {boolean}
 */
export function isIgnoredSignature(cluster, ignore) {
  if (!ignore || ignore.length === 0) return false;
  const haystacks = [cluster.normalized, ...(cluster.samples ?? [])]
    .filter((s) => typeof s === 'string')
    .map((s) => s.toLowerCase());
  return ignore.some((needle) => {
    const n = String(needle).toLowerCase();
    return n !== '' && haystacks.some((h) => h.includes(n));
  });
}

/**
 * 把一份 analysis 渲染成紧凑视图。
 *
 * 与详细报告的差别：每个问题簇一行（计数 + 签名 + 归属桶），没有堆栈、样本、
 * inferredTypes、文件列表。数据量从数 KB 降到几百字节，适合「先扫一眼再决定要不要细看」。
 *
 * @param {object} analysis - `analyze()` 的完整返回值。
 * @param {object} [options]
 * @param {string[]} [options.ignore] - 已知噪音的忽略子串列表（v1.6.6 起由 settings 自动填充）。
 * @param {number} [options.maxWarnings] - 警告签名最多保留几条，默认 12。
 * @returns {object} 紧凑视图负载。
 */
export function buildCompact(analysis, options = {}) {
  const ignore = Array.isArray(options.ignore) ? options.ignore : [];
  const maxWarnings = Number(options.maxWarnings) || 12;

  let ignoredEvents = 0;
  let ignoredSignatures = 0;
  const kept = [];
  for (const cluster of analysis?.clusters ?? []) {
    if (ignore.length > 0 && isIgnoredSignature(cluster, ignore)) {
      ignoredEvents += cluster.occurrences;
      ignoredSignatures += 1;
      continue;
    }
    kept.push(cluster);
  }

  const errors = kept.filter((c) => c.level === 'ERROR');
  const warnings = kept.filter((c) => c.level === 'WARNING');

  return {
    generatedAt: analysis?.generatedAt,
    profile: analysis?.profile,
    overview: (analysis?.sources ?? []).map((s) => ({
      label: s.label,
      available: s.available,
      incremental: s.incremental,
      entries: s.entries,
      errors: s.summary?.errors,
      warnings: s.summary?.warnings,
    })),
    totals: {
      entries: analysis?.totals?.entries,
      errors: analysis?.totals?.errors,
      warnings: analysis?.totals?.warnings,
    },
    ignored: ignoredSignatures > 0 ? { signatures: ignoredSignatures, events: ignoredEvents } : undefined,
    errorSignatures: errors.map(signatureLine),
    warningSignatures: warnings.slice(0, maxWarnings).map(signatureLine),
  };
}

/**
 * 比较两份 analysis，回答「这次比上次新增/消失了什么」。
 *
 * 语义约定（与 delta 分析的差别）：`analyze` 的增量游标比的是**字节范围**，重开会话后
 * 上次的游标对不上新文件；本函数比的是**签名集合**——两份日志各自聚类，然后做集合差。
 * 因此两边都必须 `full: true` 且 `persist: false`（见 index.js 的 diff 分支）。
 *
 * @param {object} current - 当前会话的 analysis。
 * @param {object} previous - 上一次会话的 analysis。
 * @param {object} [options]
 * @param {boolean} [options.includeWarnings] - 连警告一起比（默认只比 ERROR）。
 * @param {number} [options.threshold] - 计数变化进入 changed 的最小绝对差，默认 2。
 * @param {number} [options.limit] - 每个分区最多保留几条，默认 30。
 */
export function diffAnalyses(current, previous, options = {}) {
  const levels = options.includeWarnings ? ['ERROR', 'WARNING'] : ['ERROR'];
  const threshold = Number(options.threshold) || 2;
  const limit = Number(options.limit) || 30;

  const mapOf = (analysis) => {
    const map = new Map();
    for (const cluster of analysis?.clusters ?? []) {
      if (!levels.includes(cluster.level)) continue;
      const bucket = attributionBucket(cluster);
      const row = {
        level: cluster.level,
        count: cluster.occurrences,
        sig: String(cluster.normalized ?? cluster.samples?.[0] ?? '').slice(0, SIGNATURE_SLICE),
        mod: bucket.label,
      };
      const existing = map.get(row.sig);
      if (existing) existing.count += row.count;
      else map.set(row.sig, row);
    }
    return map;
  };

  const cur = mapOf(current);
  const prev = mapOf(previous);

  const added = [];
  const removed = [];
  const changed = [];
  for (const [sig, row] of cur) {
    const before = prev.get(sig);
    if (!before) {
      added.push({ ...row, previousCount: 0 });
    } else if (Math.abs(row.count - before.count) >= threshold) {
      changed.push({ ...row, previousCount: before.count, delta: row.count - before.count });
    }
  }
  for (const [sig, row] of prev) {
    if (!cur.has(sig)) removed.push({ ...row, currentCount: 0 });
  }

  const byCount = (a, b) => b.count - a.count;
  const byDelta = (a, b) => Math.abs(b.delta) - Math.abs(a.delta);
  const totalsOf = (analysis) => ({
    entries: analysis?.totals?.entries,
    errors: analysis?.totals?.errors,
    warnings: analysis?.totals?.warnings,
  });

  return {
    current: totalsOf(current),
    previous: totalsOf(previous),
    added: added.sort(byCount).slice(0, limit),
    removed: removed.sort(byCount).slice(0, limit),
    changed: changed.sort(byDelta).slice(0, limit),
  };
}
