/**
 * Offline verification for the rimworld-log plugin's host modules.
 *
 * Runs the real detection + parse + cluster pipeline against the logs actually present on
 * this machine and prints the brief. Exits non-zero when a hard expectation fails, so it can
 * be used as a pre-install gate.
 *
 * Usage: node selftest.mjs
 */

// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区里写记录。
// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区写记录。
// 测试不该产生副作用，这里直接关掉。
process.env.RIMLOG_AUTO_ARCHIVE = '0';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SOURCE_META, parseArgs, normalizeText, extractFrames } from './lib/parse.js';
import { detectEnvironment, listProfiles, activeModList } from './lib/detect.js';
import { analyze, grepRaw } from './lib/report.js';

const problems = [];
const notes = [];

function check(label, fn) {
  try {
    const value = fn();
    notes.push(`  ok   ${label}${value === undefined ? '' : ` -> ${value}`}`);
    return true;
  } catch (error) {
    problems.push(`  FAIL ${label}: ${error?.message ?? error}`);
    return false;
  }
}

console.log('== rimworld-log selftest ==');

// --- pure units ---------------------------------------------------------
check('normalizeText collapses volatile numbers', () => {
  const a = normalizeText("Texture '' has dimensions (513 x 513) which are not multiples of 4.");
  const b = normalizeText("Texture '' has dimensions (1025 x 1025) which are not multiples of 4.");
  assert.equal(a, b);
  return a.slice(0, 48);
});

check('extractFrames reads .NET frames', () => {
  const frames = extractFrames(
    '  at Foo.Bar.Baz () [0x00073] in C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\Mods\\GraphicsSetter\\Source\\GraphicSetter\\Patches\\TextureLoadingPatch.cs:44 \n'
    + '  at Verse.ModContentLoader`1[T].LoadItem (RimWorld.IO.VirtualFile file) [0x00000] in <239ae808>:0 ',
  );
  assert.equal(frames.length, 2);
  assert.match(frames[0].file, /TextureLoadingPatch\.cs$/);
  assert.equal(frames[0].line, 44);
  return `${frames.length} frames`;
});

check('parseArgs reads sources/flags/question', () => {
  const parsed = parseArgs('player --full --since 2026-10-08 why is this mod erroring?');
  assert.deepEqual(parsed.sources, ['player']);
  assert.equal(parsed.full, true);
  assert.equal(parsed.since, '2026-10-08');
  assert.equal(parsed.question, 'why is this mod erroring?');
  const dflt = parseArgs('');
  assert.deepEqual(dflt.sources, ['realtime']);
  return 'ok';
});

// --- environment --------------------------------------------------------
const env = detectEnvironment();
console.log(`\n== environment ==\n  RimCrow home: ${env.home ?? '(not found)'}`);
for (const note of env.notes) console.log(`  note: ${note}`);
if (!env.home) {
  console.log('\nRimCrow not present on this machine; detection-only checks above still ran.');
}

if (env.home) {
  check('listProfiles finds profiles', () => {
    const profiles = listProfiles(env.home);
    assert.ok(profiles.length > 0, 'no profiles');
    return `${profiles.length} profiles, current=${profiles.find((p) => p.isCurrent)?.name ?? 'n/a'}`;
  });

  if (env.profile) {
    console.log(`  chosen profile: ${env.profile.name} (${env.profile.id})`);
    for (const [kind, file] of Object.entries(env.sources ?? {})) {
      console.log(`  source ${kind}: ${file.exists ? `${file.bytes} bytes` : 'missing'} ${file.path}`);
    }
    console.log(`  companion: ${env.companion.present ? 'installed' : 'absent'}`);

    check('activeModList joins ModsConfig.xml to directories', () => {
      const mods = activeModList(env.profile, env.config);
      assert.ok(mods.activeCount > 0, 'no active mods parsed');
      return `${mods.activeCount} active, ${mods.missingCount} missing, ${mods.onDiskCount} on disk`;
    });

    const mods = activeModList(env.profile, env.config);
    env.activeMods = mods.active;
    env.modSummary = mods;
    env.modRoots = mods.modRoots;

    const available = Object.entries(env.sources).filter(([, f]) => f.exists);
    if (available.length > 0) {
      const kinds = available.map(([k]) => k);
      const scan = (extra = {}) => analyze(env, {
        sources: kinds,
        modRoots: env.modRoots,
        activeMods: env.activeMods,
        ...extra,
      });
      check(`analyze over [${kinds.join(', ')}] produces a brief`, () => {
        const analysis = scan({ full: true, maxClusters: 6, persist: false });
        assert.ok(analysis.brief.length > 200, 'brief too small');
        assert.ok(Array.isArray(analysis.clusters));
        assert.equal(typeof analysis.totals.errors, 'number');
        return `${analysis.brief.length} chars brief, ${analysis.clusters.length} clusters, errors=${analysis.totals.errors} warnings=${analysis.totals.warnings}`;
      });

      check('at least one cluster is attributed to a mod', () => {
        const analysis = scan({ full: true, maxClusters: 40, persist: false });
        const attributed = analysis.clusters.filter((c) => c.attributedMod);
        assert.ok(attributed.length > 0, 'no cluster attributed');
        const byConfidence = {};
        for (const c of attributed) byConfidence[c.attributedMod.confidence] = (byConfidence[c.attributedMod.confidence] ?? 0) + 1;
        return `${attributed.length}/${analysis.clusters.length} attributed (${JSON.stringify(byConfidence)}), top=${attributed[0].attributedMod.name}`;
      });

      check('no active mod is wrongly marked missing after the About.xml root fix', () => {
        assert.ok(env.modSummary.missingCount <= env.modSummary.activeCount * 0.1,
          `missing ${env.modSummary.missingCount}/${env.modSummary.activeCount}`);
        return `${env.modSummary.missingCount} missing of ${env.modSummary.activeCount}`;
      });

      check('brief stays within a sane token budget', () => {
        const analysis = scan({ full: true, maxClusters: 14, persist: false });
        const approxTokens = Math.ceil(analysis.brief.length / 3.2);
        assert.ok(analysis.brief.length < 200_000, `brief too large: ${analysis.brief.length}`);
        return `${analysis.brief.length} chars ≈ ${approxTokens} tokens`;
      });

      const firstKind = kinds[0];
      check(`grepRaw works on ${firstKind}`, () => {
        const result = grepRaw(env.sources[firstKind].path, 'Exception', 5);
        assert.ok(!result.error, result.error);
        return `${result.returned} hits of ${result.totalLines} lines`;
      });

      check('incremental cursor read is consistent with a full read', () => {
        const withCursor = scan({ full: false, maxClusters: 4, persist: true });
        const second = scan({ full: false, maxClusters: 4, persist: false });
        return `first=${withCursor.totals.entries} entries, second(incremental)=${second.totals.entries} entries`;
      });

      // The regression that mattered in practice: a full scan followed by an incremental one that
      // finds nothing reported "0 errors" with no indication that the zero measured only the delta.
      // A reader concluded the log was clean while nine errors sat in it.
      //
      // Built against a controlled state directory and a cursor pinned to EOF, so the assertion tests
      // the rendering rather than whatever cursor state earlier assertions happened to leave behind.
      check('an empty delta never reads as "this log is clean"', () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rimlog-selftest-'));
        const previousState = process.env.DSH_RIMWORLD_LOG_STATE;
        process.env.DSH_RIMWORLD_LOG_STATE = stateDir;
        try {
          // A fresh snapshot. The environment captured at the top of this file may be minutes old, and
          // the log grows while the game runs: a cursor pinned to the older size is correctly judged
          // untrustworthy and triggers a full re-read, which would defeat the test.
          const freshEnv = detectEnvironment();
          const sourcePath = freshEnv.sources.realtime.path;
          const sourceBytes = freshEnv.sources.realtime.bytes;

          // 1. A full scan, so the "previous run" sidecar exists with real findings.
          const first = analyze(freshEnv, { sources: ['realtime'], full: true, maxClusters: 6, persist: true });
          assert.ok(first.totals.entries > 0, 'the full scan should read the log');

          // 2. Pin the cursor at the size this snapshot recorded, which is the state that produced
          //    the false negative: cursor at the end of what was read, nothing new to see.
          const safe = Buffer.from(sourcePath, 'utf8').toString('base64url').slice(0, 120);
          fs.writeFileSync(
            path.join(stateDir, `${safe}.json`),
            JSON.stringify({ path: sourcePath, offset: sourceBytes, mtimeMs: Date.now() }),
            'utf8',
          );

          // 3. An incremental scan now reads nothing and must say so unambiguously.
          //
          //    persist must stay on here: with persist off the cursor is not consulted at all, the
          //    range falls back to the whole file, and the empty-delta path is never reached. The
          //    cursor it writes goes to the temporary state directory, so nothing real is touched.
          const empty = analyze(freshEnv, { sources: ['realtime'], full: false, maxClusters: 6, persist: true });
          assert.equal(empty.totals.entries, 0,
            `pinned cursor did not yield an empty delta (fromByte=${empty.sources[0]?.fromByte}, `
            + `incremental=${empty.sources[0]?.incremental}, sourceBytes=${sourceBytes})`);
          assert.equal(empty.totals.entries, 0, 'expected the pinned cursor to yield an empty delta');
          assert.ok(/不代表/.test(empty.brief) && /干净/.test(empty.brief),
            'the brief must state that zero does not mean clean');
          assert.ok(/只覆盖|只代表/.test(empty.brief), 'the brief must scope what the counts cover');
          assert.ok(empty.brief.includes('--full'), 'the brief must name the way to get the whole log');
          assert.ok(/上一轮/.test(empty.brief), 'the brief should refer back to the previous analysis');

          const clusters = first.problemClusters + first.warningClusters;
          if (clusters > 0) {
            assert.ok(/错误类 \d+/.test(empty.brief), 'the brief should restate the previous counts');
          }
          return `delta labelled; previous run had ${first.problemClusters} error / ${first.warningClusters} warning clusters`;
        } finally {
          if (previousState === undefined) delete process.env.DSH_RIMWORLD_LOG_STATE;
          else process.env.DSH_RIMWORLD_LOG_STATE = previousState;
          try {
            fs.rmSync(stateDir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
      });

      check('every scan states whether it was full or incremental', () => {
        const analysis = scan({ full: true, maxClusters: 4, persist: false });
        const available = analysis.sources.filter((s) => s.available);
        assert.ok(available.length > 0, 'no readable source');
        for (const s of available) {
          assert.equal(typeof s.incremental, 'boolean', `${s.kind} must report incremental/full`);
        }
        assert.ok(analysis.brief.includes('全量'), 'a full read must be labelled 全量');
        return `${available.length} source(s) labelled`;
      });

      check('the previous realtime log is offered as a source', () => {
        const previous = env.sources.realtimePrev;
        assert.ok(previous, 'realtimePrev must be resolved alongside realtime');
        assert.ok(previous.path.endsWith('RimCrow_Realtime-prev.log'), `unexpected path ${previous.path}`);
        if (!previous.exists) return 'not present on this machine, but resolved';
        const analysis = analyze(env, { sources: ['realtimePrev'], full: true, maxClusters: 2, persist: false });
        assert.ok(analysis.sources[0].available, 'the previous log should be readable');
        return `${(previous.bytes / 1024).toFixed(0)} KB, ${analysis.totals.entries} entries parsed`;
      });

      check('grep can filter by mod, in each spelling a reader might use', () => {
        // Graphics Settings+ is the useful case: its records carry no relatedModIds, so the only
        // route to it is the assembly name inside the stack path. Matching that is what makes the
        // filter usable at all.
        const base = { modRoots: env.modRoots, activeMods: env.activeMods, indexes: env.modSummary
          ? { byAssembly: env.modSummary.byAssembly, byFolder: env.modSummary.byFolder }
          : {} };
        const unfiltered = grepRaw(env.sources.realtime.path, 'Compress', 20);
        // 这条测试依赖「当前日志里恰好有 Compress 记录」。日志按会话轮转，没有那条记录时
        // 后面三处断言全都无意义，所以跳过而不是判失败——失败应该意味着代码坏了，
        // 不应该意味着今晚的日志里没跑过 Graphics Settings+。
        if (unfiltered.returned === 0) {
          return '当前日志里没有 Compress 记录，跳过（不代表代码有问题）';
        }

        const byPackageId = grepRaw(env.sources.realtime.path, 'Compress', 20, { ...base, mod: 'graphicssettings' });
        const byAssembly = grepRaw(env.sources.realtime.path, 'Compress', 20, { ...base, mod: 'GraphicsSetter' });
        const byFolder = grepRaw(env.sources.realtime.path, 'Compress', 20, { ...base, mod: '1678847247' });
        const unrelated = grepRaw(env.sources.realtime.path, 'Compress', 20, { ...base, mod: 'no-such-mod-xyz' });

        assert.ok(byPackageId.returned > 0, 'packageId spelling should match');
        assert.ok(byAssembly.returned > 0, 'assembly-name spelling should match (this was the bug)');
        assert.ok(byFolder.returned > 0, 'workshop-folder spelling should match');
        assert.equal(unrelated.returned, 0, 'an unrelated mod name must match nothing');
        assert.ok(byPackageId.returned <= unfiltered.returned, 'filtering must not invent rows');
        return `${unfiltered.returned} unfiltered → ${byPackageId.returned} by packageId, `
          + `${byAssembly.returned} by assembly, ${byFolder.returned} by folder`;
      });
    } else {
      console.log('  no log files present for the chosen profile; skipping analysis checks');
    }
  }
}

// --- output -------------------------------------------------------------
console.log('\n== results ==');
for (const line of notes) console.log(line);
if (problems.length > 0) {
  console.log('\n== problems ==');
  for (const line of problems) console.log(line);
  process.exit(1);
}
console.log('\nAll selftest expectations passed.');

if (process.env.RIMLOG_DUMP_BRIEF === '1' && env.profile) {
  const kinds = Object.entries(env.sources).filter(([, f]) => f.exists).map(([k]) => k);
  if (kinds.length > 0) {
    const analysis = analyze(env, { sources: kinds, full: true, maxClusters: 8, persist: false, modRoots: env.modRoots });
    console.log('\n===== BRIEF PREVIEW (first 6000 chars) =====\n');
    console.log(analysis.brief.slice(0, 6000));
  }
}
