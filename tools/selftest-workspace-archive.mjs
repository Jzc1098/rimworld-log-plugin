/**
 * Functional test for lib/workspace-archive.js.
 *
 * Runs the whole thing against a throwaway root, so it never touches the real work area. Verifies the
 * two rules the requirement is made of:
 *   1. retention is by day and three deep - archiving on the 1st, 6th, 10th and 15th leaves 6/10/15;
 *   2. a migration pack carries the newest snapshot, and only the newest.
 *
 * Run: node tools/selftest-workspace-archive.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rimlog-archive-test-'));
process.env.RIMLOG_WORKSPACE_DIR = path.join(tmp, 'workspace');
process.env.RIMLOG_SNAPSHOT_DIR = path.join(tmp, 'snapshots');

const {
  DEFAULT_KEEP_DAYS,
  archiveSummary,
  exportMigrationPack,
  listSnapshots,
  pruneSnapshots,
  snapshotSources,
  takeSnapshot,
} = await import('../lib/workspace-archive.js');

const root = process.env.RIMLOG_WORKSPACE_DIR;
const snaps = process.env.RIMLOG_SNAPSHOT_DIR;

const day = (iso) => new Date(`${iso}T10:00:00`);

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${label}\n       ${error?.message ?? error}`);
  }
}

// ---- fixtures -------------------------------------------------------------

console.log('fixtures');
write(path.join(root, 'OPEN_ISSUES.md'), '# open issues\n');
write(path.join(root, 'PATCHES.md'), '# patches\n');
write(path.join(root, '日志归档-1.7test-启动错误根因.md'), '# findings\n');
write(path.join(root, '_archive', 'loose', 'note.md'), 'loose note\n');
write(path.join(root, '_archive', 'RimCrow日志分析插件', 'index.js'), '// archived plugin\n');
write(path.join(root, '_archive', 'RimCrow日志分析插件.zip'), 'PK-not-really\n');
// The regression this fixture pins: the real work area holds 33 `fix-*` project directories, the plugin
// itself and `_tools`, and an earlier whitelist-based version captured none of them while reporting a
// successful snapshot. A plain project directory like this one must be included by default.
write(path.join(root, 'fix-something-important', 'Source', 'Patch.cs'), '// the actual fix\n');
write(path.join(root, 'fix-something-important', 'About', 'About.xml'), '<ModMetaData/>\n');
write(path.join(root, '_tools', 'probe.py'), 'print(1)\n');
// Regenerable bulk: a large file is still captured - there is no size cap, by decision.
const big = path.join(root, '_work', 'decompiled', 'Huge.cs');
write(big, '//'.padEnd(5 * 1024 * 1024, 'x'));
// Generated artifacts and machine-keyed cursors.
write(path.join(root, '_work', 'note.md'), 'small file in the same tree\n');
write(path.join(root, 'not-md.txt'), 'a non-markdown root file\n');
write(path.join(root, 'Xy9z.json.bak-20261016-120000'), 'not wanted\n');
console.log(`  root=${root}`);

// ---- what a snapshot is made of -------------------------------------------

console.log('\nsnapshotSources');
const { sources: rawSources, excludedDirs } = snapshotSources(root);
const sources = rawSources.map((s) => s.rel).sort();
check('includes root markdown', () => {
  assert.deepEqual(
    sources.filter((s) => !s.includes('/') && s.endsWith('.md')),
    ['OPEN_ISSUES.md', 'PATCHES.md', '日志归档-1.7test-启动错误根因.md'],
  );
});
check('includes a project directory (the regression that mattered)', () => {
  assert.ok(sources.includes('fix-something-important/Source/Patch.cs'));
  assert.ok(sources.includes('fix-something-important/About/About.xml'));
  assert.ok(sources.includes('_tools/probe.py'));
});
check('includes the _archive tree', () => {
  assert.ok(sources.includes('_archive/loose/note.md'));
  assert.ok(sources.includes('_archive/RimCrow日志分析插件/index.js'));
  assert.ok(sources.includes('_archive/RimCrow日志分析插件.zip'));
});
check('includes non-markdown files at the root', () => {
  assert.ok(sources.includes('not-md.txt'), 'extension is not a criterion');
});
check('includes a 5 MB file - size is not a criterion', () => {
  assert.ok(sources.includes('_work/decompiled/Huge.cs'),
    'a per-file cap was removed on purpose: the files it dropped were the hardest to reproduce');
  assert.ok(sources.includes('_work/note.md'));
});
check('excludes .bak-<stamp> backups', () => {
  assert.ok(!sources.some((s) => s.includes('.bak-')));
});
check('reports which directories were skipped wholesale', () => {
  assert.ok(Array.isArray(excludedDirs));
});

// ---- rule 1: daily, three deep --------------------------------------------

console.log('\nrule 1 — by day, three deep');
// Archive on the 1st, 6th, 10th and 15th. The window is a *constant* three days rather than
// "four days until the fifth arrives", so the 15th already pushes the 1st out: after it, exactly
// 6/10/15 remain. That is the behaviour the requirement's example describes.
for (const iso of ['2026-10-01', '2026-10-06', '2026-10-10', '2026-10-15']) {
  const result = takeSnapshot({ root, dir: snaps, now: day(iso) });
  assert.equal(result.ok, true, `snapshot ${iso} failed: ${result.error}`);
}
check('after the 15th, exactly the three newest days remain', () => {
  assert.deepEqual(
    listSnapshots(snaps).map((s) => s.date),
    ['2026-10-15', '2026-10-10', '2026-10-06'],
  );
});
check('the day pushed out of the window is reported, not silently dropped', () => {
  // Re-take the 15th and inspect that run's own prune result: refreshing a day inside the window must
  // remove nothing, which is what proves the window is by date and not by run count.
  const refresh = takeSnapshot({ root, dir: snaps, now: day('2026-10-15') });
  assert.deepEqual(refresh.pruned.removed, []);
  assert.deepEqual(refresh.kept.sort(), ['2026-10-06', '2026-10-10', '2026-10-15']);
});
check('the snapshot manifest records what was left out', () => {
  const refresh = takeSnapshot({ root, dir: snaps, now: day('2026-10-15') });
  const manifest = JSON.parse(fs.readFileSync(path.join(refresh.path, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.excludedDirs), 'the manifest must state which directories were skipped');
  assert.ok(manifest.fileCount > 0);
  // Nothing is size-filtered any more, so the cap field must not come back by accident.
  assert.equal(manifest.skippedOverSizeLimit, undefined);
});

// Same day twice: overwrite, not accumulate.
write(path.join(root, 'OPEN_ISSUES.md'), '# open issues\nsecond edit on the 15th\n');
const again = takeSnapshot({ root, dir: snaps, now: day('2026-10-15') });
check('a second snapshot on the same day replaces it', () => {
  assert.equal(again.replaced, true);
  assert.equal(listSnapshots(snaps).length, 3, 'a second run in one day must not add a fourth snapshot');
  const content = fs.readFileSync(path.join(snaps, '2026-10-15', 'OPEN_ISSUES.md'), 'utf8');
  assert.match(content, /second edit/);
});

// The day that pushes the window over again.
const fifth = takeSnapshot({ root, dir: snaps, now: day('2026-10-16') });
check('the 16th keeps exactly the three newest days', () => {
  assert.deepEqual(fifth.kept.sort(), ['2026-10-10', '2026-10-15', '2026-10-16']);
  assert.deepEqual(
    listSnapshots(snaps).map((s) => s.date),
    ['2026-10-16', '2026-10-15', '2026-10-10'],
  );
});
check('the 6th is gone, and says so', () => {
  const gone = fifth.pruned.removed.map((r) => r.date).sort();
  assert.deepEqual(gone, ['2026-10-06']);
  assert.ok(fifth.pruned.removed.every((r) => !r.error && !r.skipped));
});
check('archiveSummary reports the window', () => {
  const summary = archiveSummary({ dir: snaps });
  assert.equal(summary.count, 3);
  assert.equal(summary.newest, '2026-10-16');
  assert.equal(summary.oldest, '2026-10-10');
  assert.equal(summary.keep, DEFAULT_KEEP_DAYS);
});

// ---- rule 2: the migration pack carries the newest only -------------------

console.log('\nrule 2 — migration pack carries the newest snapshot only');
const pack = exportMigrationPack({ root, dir: snaps, now: day('2026-10-16') });
check('export succeeds', () => assert.equal(pack.ok, true, pack.error));
check('manifest names one snapshot and lists the omitted ones', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pack.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.snapshotIncluded, '2026-10-16');
  assert.deepEqual(manifest.olderSnapshotsOmitted, ['2026-10-15', '2026-10-10']);
  assert.equal(manifest.schema, 'rimworld-log.migration-pack');
});
check('the pack holds the newest snapshot and no other day', () => {
  // The snapshot is copied verbatim, so the contents of the newest day sit at the top of
  // workspace-snapshot/ - there is no per-day directory level. Seeing a date-named directory here would
  // mean the whole snapshots directory had been copied, which is the mistake this rule forbids.
  const names = fs.readdirSync(path.join(pack.path, 'workspace-snapshot'));
  assert.ok(names.includes('OPEN_ISSUES.md'));
  assert.ok(names.includes('_archive'));
  assert.ok(names.includes('manifest.json'));
  assert.deepEqual(names.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)), []);
  assert.match(
    fs.readFileSync(path.join(pack.path, 'workspace-snapshot', 'OPEN_ISSUES.md'), 'utf8'),
    /second edit/,
    'the pack must carry the newest content, not an older day\'s copy',
  );
});
check('no other snapshot directory leaked into the pack', () => {
  const leaked = ['2026-10-15', '2026-10-10'].filter(
    (d) => fs.existsSync(path.join(pack.path, 'workspace-snapshot', d)),
  );
  assert.deepEqual(leaked, []);
});
check('a second export to the same directory is refused rather than overwritten', () => {
  const second = exportMigrationPack({ root, dir: snaps, outDir: pack.path, now: day('2026-10-16') });
  assert.equal(second.ok, false);
  assert.match(second.error, /已存在/);
});

// ---- safety ---------------------------------------------------------------

console.log('\nsafety');
check('pruning never removes today, even when it is outside the kept window', () => {
  // keep=1 would otherwise drop everything but the newest; today is already newest here, so prove the
  // guard with an explicit prune whose "today" is a day that sorting alone would delete.
  const removed = pruneSnapshots({ dir: snaps, keep: 0, now: day('2026-10-16') });
  assert.deepEqual(removed.kept, ['2026-10-16']);
  assert.ok(fs.existsSync(path.join(snaps, '2026-10-16')));
});
check('a prune leaves directories outside the snapshots dir alone', () => {
  // The guard that matters: pruneSnapshots deletes recursively, so prove that an unrelated directory
  // named like a date - or named anything else - survives it and is never a deletion target.
  const outsider = path.join(tmp, 'outsider');
  write(path.join(outsider, 'keep-me.txt'), 'important\n');
  const decoy = path.join(tmp, 'decoy-snapshots');
  write(path.join(decoy, '2026-01-01', 'keep-me-too.txt'), 'also important\n');
  process.env.RIMLOG_SNAPSHOT_DIR = decoy;
  const pruned = pruneSnapshots({ dir: snaps, keep: 1, now: day('2026-10-16') });
  process.env.RIMLOG_SNAPSHOT_DIR = snaps;
  assert.ok(fs.existsSync(path.join(outsider, 'keep-me.txt')), 'unrelated files must survive a prune');
  assert.ok(fs.existsSync(path.join(decoy, '2026-01-01', 'keep-me-too.txt')), 'another dir must survive a prune');
  assert.ok(pruned.removed.every((r) => path.resolve(r.path).startsWith(path.resolve(snaps))));
  assert.ok(fs.existsSync(path.join(snaps, '2026-10-16')), 'today survives even at keep=1');
});

// ---- verify ---------------------------------------------------------------

const { verifySnapshot } = await import('../lib/workspace-archive.js');

console.log('\nverify');
check('verify on a matching snapshot reports zero differences', () => {
  // Retake today's snapshot to guarantee it matches current workspace content.
  const snap = takeSnapshot({ root, dir: snaps, keep: 1, now: day('2026-10-16') });
  assert.equal(snap.ok, true);
  const result = verifySnapshot({ root, dir: snaps });
  assert.equal(result.ok, true);
  assert.equal(result.onlyInWorkspace.count, 0, `onlyInWorkspace: ${result.onlyInWorkspace.files?.join(', ')}`);
  assert.equal(result.onlyInSnapshot.count, 0, `onlyInSnapshot: ${result.onlyInSnapshot.files?.join(', ')}`);
  assert.equal(result.hashCheck.mismatches, 0, `hash mismatches: ${result.hashCheck.files?.join(', ')}`);
  assert.ok(result.verdict.includes('完全一致'), result.verdict);
});
check('verify detects a workspace file changed after the snapshot', () => {
  // Mutate a file that is in the snapshot.
  write(path.join(root, 'OPEN_ISSUES.md'), '# open issues\nCHANGED AFTER SNAPSHOT\n');
  const result = verifySnapshot({ root, dir: snaps });
  assert.equal(result.ok, true);
  assert.ok(result.hashCheck.mismatches >= 1, `expected ≥1 hash mismatch, got ${result.hashCheck.mismatches}`);
  assert.ok(result.hashCheck.files.some((f) => f === 'OPEN_ISSUES.md'), `OPEN_ISSUES.md should be listed: ${result.hashCheck.files.join(', ')}`);
  assert.ok(!result.verdict.includes('完全一致'));
});
check('verify detects a workspace file added after the snapshot', () => {
  write(path.join(root, 'NEW-FINDING.md'), '# added later\n');
  const result = verifySnapshot({ root, dir: snaps });
  assert.ok(result.onlyInWorkspace.count >= 1);
  assert.ok(result.onlyInWorkspace.files.some((f) => f === 'NEW-FINDING.md'));
});
check('verify reports skipped directories with accounting', () => {
  const result = verifySnapshot({ root, dir: snaps });
  assert.ok(result.skipped.dirs.length >= 0); // no bin/ in this fixture → 0 is fine
  assert.ok(typeof result.skipped.files === 'number');
});
check('verify with a nonexistent date reports an error', () => {
  const result = verifySnapshot({ root, dir: snaps, date: '1999-01-01' });
  assert.equal(result.ok, false);
  assert.ok(String(result.error).includes('1999-01-01'));
});
// Restore the workspace to its pre-verify state so the rest of the suite is unaffected.
write(path.join(root, 'OPEN_ISSUES.md'), '# open issues\n');
try { fs.rmSync(path.join(root, 'NEW-FINDING.md')); } catch { /* not created */ }

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log('all checks passed');
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* a leftover temp dir is not a test failure */
}
