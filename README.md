# RimWorld Log Analysis Plugin for DSH

[中文](README.zh-CN.md) · **English**

> **Ludeon notice**
>
> Portions of the materials used to create this content/mod are trademarks and/or
> copyrighted works of Ludeon Studios Inc. All rights reserved by Ludeon. This
> content/mod is not official and is not endorsed by Ludeon.

A **read-only** [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) plugin that
reads and pre-clusters RimWorld game logs (RimCrow recommended), hands the findings to the current
agent session, and lets the model pinpoint mod conflicts, crash causes and frame drops. It never
modifies the game or the mod list.

- First public version: **v1.6.9**
- License: **PolyForm Noncommercial 1.0.0** (noncommercial, source-available) — [LICENSE](LICENSE); third-party notices and the RimWorld/Ludeon rules — [NOTICE.md](NOTICE.md)
- Free, as the RimWorld EULA requires: not sold, no ads, no donation requests inside the plugin
- Note: **the plugin's runtime output is currently Chinese.** Only this README is bilingual; the
  other documents are Chinese for now (see [Docs](#docs))

---

## What it does

| It does | It does not |
|---|---|
| Read RimCrow realtime logs / Player.log, cluster errors and warnings | Modify RimWorld or `ModsConfig.xml` |
| Attribute a problem to a specific mod with evidence and samples | Enable or disable mods for you (it prints the list; you tick the boxes) |
| Draft and audit fix patches (XML patches, Harmony DLL workspaces) | Download or distribute any third-party mod content |
| Snapshot and verify the workspace, export a migration pack | Upload any log or file anywhere |

## Requirements

| Required / optional | What |
|---|---|
| **Required** | [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) desktop, working |
| **Required** | Node.js 20+ and pnpm (to install the one runtime dependency) |
| **Optional** | [RimCrow](https://github.com/rimcrow/RimCrow): with it the logs are structured JSON and analysis quality improves a lot |
| **Optional** | Plain `Player.log` works without RimCrow, with less information |

## Quick start (paste each step into DSH)

### Step 0 — environment check

```text
Check my environment: Node version, whether pnpm is available, DSH version,
whether RimCrow is installed, and where RimWorld lives.
Give me one runnable install command for anything missing — don't just describe it.
```

### Step 1 — install the dependency (this repository ships no node_modules)

In the repository root:

```bash
pnpm install
```

(No pnpm? use `npm install`.)

> Why: the plugin exports `Config` (a Schemastery schema for DSH row config), so it needs the public
> npm package `schemastery` at runtime. Without it, installing the plugin fails with
> `ERR_MODULE_NOT_FOUND`. After the install, `node_modules/schemastery` should exist.

### Step 2 — install the plugin

Paste this into DSH, replacing the path with your absolute clone path:

```text
Install this directory with plugin_manager install_bundle: <absolute path to this repository>.
Report the result (applied / failed with the original text) and remind me to restart DSH.
```

> Do not hand-edit the profile's `package.json` or `cordis.patch.yml`, and do not run `pnpm install`
> inside the profile directory.

### Step 3 — restart DSH

Quit the DSH process and start it again (the module cache is keyed by package, not by row).

### Step 4 — verify

```text
Run rimworld_plugin_guide action=usage to confirm the tools are registered,
then rimworld_log_scan action=detect to confirm the logs are reachable,
then analyze the most recent game log and report only new ERRORs with their owning mod.
```

## Features (tools and actions)

### `rimworld_log_scan` (analysis)

| `action` | What it does |
|---|---|
| `analyze` (default) | Cluster errors/warnings, attribute them to mods, show evidence and samples; `compact=true` gives one line per cluster (engine frames folded); `ignore` filters known noise |
| `detect` | Environment and log-source inventory (profile, log files, enabled mods, cost/benefit per source) |
| `grep` | Search the raw log by substring or /regex/; `context=0..3` includes neighbouring lines |
| `mods` | Draft an enable/disable list (**draft only, never writes**) |
| `mods-changed` | Mods updated/added/removed in a time window (directory mtime + About version vs baseline) |
| `diff` | This session vs the previous one: new / gone / count changes |
| `patchaudit` | Workspace sources vs deployed DLLs: hash and mtime comparison |
| `aboutcheck` | Six About.xml checks (structure, bare `&`, description type, BOM/mojibake) |

### `rimworld_workspace_archive` (archive)

`list` / `snapshot` (keeps the newest three days) / `export` (migration pack, newest snapshot only) /
`verify` (snapshot vs workspace, file by file) / `note` (write an archive record and snapshot).

### `rimworld_plugin_guide` (self-report)

`report` / `usage` (generated live from the tool registry) / `since` / `config` (effective settings and
the **origin of each value**).

### `rimworld_plugin_compare` (block comparison)

Compare this plugin against another copy, block by block (it does not decide which one is newer).

### Commands

`/rimlog` and `/rimmods`.

## Settings

After installing and restarting, **Settings → “RimWorld 日志”** (a page of its own, below the
agent-preset section) exposes seven keys that can be edited directly.

Priority (highest first):

1. **Environment variables**
2. **The settings page** (written into the profile patch)
3. `~/.dsh/rimworld-log/settings.json`
4. Built-in defaults

Two honest notes: **saving requires a DSH restart to take effect** (the loaded host half does not
hot-reload configuration), and **environment variables always win**.

## Environment variables

| Variable | Purpose |
|---|---|
| `RIMWORLD_DIR` | RimWorld install root (contains `Data/`, `Mods/`) |
| `WORKSHOP_DIR` | Steam Workshop content `…/workshop/content/294100` |
| `RIMCROW_HOME` | RimCrow install root (when not in the default place) |
| `CE_MOD_DIR` | Combat Extended mod directory (used by the CE diagnostic scripts) |
| `VISUAL_EXCEPTIONS_DLL` | VisualExceptions DLL path (used by `tools/probe-ve.mjs`) |
| `DSH_RIMWORLD_PATCH_DIR` | Where generated patches go (default `~/.dsh/rimworld-log/patches`) |
| `RIMLOG_WORKSPACE_DIR` | Workspace directory (source of snapshots and archives) |
| `RIMLOG_STATE_DIR` | Plugin state directory (default `~/.dsh/rimworld-log`) |
| `RIMLOG_SNAPSHOT_DIR` | Snapshot directory (default `snapshots/` beside the workspace) |
| `RIMLOG_AUTO_ARCHIVE=0` | Disable the automatic archive note after an analysis |

## Troubleshooting

Paste this into DSH when the tools do not load or the settings page is missing:

```text
Troubleshoot: first check plugin_manager list_plugins for rimworld-log and show the original error;
then confirm node_modules/schemastery exists in the plugin directory (if not, pnpm install);
then confirm I restarted DSH.
```

Checklist:

1. Does `node_modules/schemastery` exist in the plugin directory? If not, step 1 was skipped.
2. Is `rimworld-log` enabled or failed in `list_plugins`? Read the diagnostic text when it failed.
3. Did you restart DSH? (Both the tools and the settings page only appear after a restart.)
4. No “RimWorld 日志” entry in the settings column? Run `rimworld_plugin_guide action=config`; if it
   prints the settings, the host half is fine and only the page registration failed — report it with
   your DSH version.
5. Logs not found? Run `rimworld_log_scan action=detect` and check the profile and log paths.

## Uninstall

```text
Remove the rimworld-log plugin with plugin_manager; tell me whether the folder and the
~/.dsh/rimworld-log state directory should be deleted, and let me decide.
```

Deleting `~/.dsh/rimworld-log` also removes the incremental cursors, the mod version baseline and an
optional `settings.json`.

## Docs

**The documents below are Chinese for now** (this README is the only bilingual one):

| Document | For whom |
|---|---|
| [使用参考.md](使用参考.md) | Users: one-line prompts you can copy into DSH |
| [安装说明.md](安装说明.md) | Full install, confirmation, troubleshooting, uninstall |
| [COMBAT_EXTENDED.md](COMBAT_EXTENDED.md) | Combat Extended compatibility reference (decision rules, four patch types, verified pitfalls, vehicles) |
| [块功能介绍.md](块功能介绍.md) | Block registry, block comparison and selective import (maintainers) |
| [插件清单.md](插件清单.md) | What every file does, which ones are safe to delete |
| [HISTORY.md](HISTORY.md) | Cumulative version history |
| [RELEASE.md](RELEASE.md) | How to build a delivery package (maintainers) |

## Version and license

**v1.6.9 — first public version.** History in [HISTORY.md](HISTORY.md).

- Plugin code and documentation: **PolyForm Noncommercial 1.0.0** — see [LICENSE](LICENSE)
  (noncommercial use, modification and redistribution allowed; commercial use not permitted)
- Ludeon Studios notice and what this repository is *not*: [NOTICE.md](NOTICE.md)
- RimWorld material belongs to Ludeon Studios Inc.; this plugin is **not official and not endorsed**
  (the verbatim notice is at the top of this page and in NOTICE.md)
- RimCrow: a separate MIT project by other authors; not bundled here
- This repository contains **no** third-party mod code, textures or data; mod names in the
  documentation are factual references only
