# CLAUDE.md — sqlui-portal

This repo is a **release coordinator**, not a source repo. The actual code lives
upstream in [`synle/sqlui-native`](https://github.com/synle/sqlui-native), vendored
here as a git submodule at `vendor/sqlui-native/`.

## What this repo does

Pins a specific `sqlui-native` commit, runs the upstream test suite, builds the
portal bundle (`npm run build:portal` upstream), smoke-tests the built artifact,
and publishes a release (`vX.Y.Z`) on this repo with the tarball attached.

That's it. There is no application code here.

## Layout

```
.github/workflows/release.yml    weekly cron + manual dispatch
.github/workflows/pr.yml         PR validation (dry-run: test + build + smoke)
scripts/release.js               the only meaningful script — 9 phases
scripts/smoke.js                 sanity check: --version + boot + HTTP probes
vendor/sqlui-native/             submodule — DO NOT modify in this repo
package.json                     version is pinned at 0.0.0 (never touched)
```

## Release flow

`scripts/release.js` runs identically locally and from CI. The workflow YAML
just forwards its dispatch inputs to the script.

### The release version comes from upstream

The release tag (`vX.Y.Z`) is **always read from `vendor/sqlui-native/package.json`**
at the resolved SHA. This repo has no version of its own. To re-release the
same upstream code with changes, upstream **must bump its `package.json`
version first**.

### Skip-vs-cleanup logic

Before building, the script inspects the existing release for the upstream
version's tag on this repo's GitHub:

| State | Action |
|---|---|
| Release exists + has `.tar.gz` asset | **SKIP** — exit 0, log `[skip] vX.Y.Z already published`. Cron shows green. |
| Release exists + zero assets (half-baked) | **CLEANUP** — `gh release delete --cleanup-tag`, then proceed |
| No release + orphan tag exists | **CLEANUP** — delete the remote tag, then proceed |
| Nothing exists | **PROCEED** — normal release |

This is the only way to "force" a re-release: upstream bumps its version. There
is no `--force` flag.

### Phases

The push is the **last** thing, so failures before it leave origin untouched:

1. `cd vendor/sqlui-native && git fetch origin --tags`, resolve `--sha`, `git checkout --detach <sha>`
2. Read upstream version → tag = `vX.Y.Z`
3. Inspect existing release state (skip/cleanup as above)
4. `npm ci`
5. `npm run test-ci` — upstream's full vitest suite
6. `npm run build:portal` — produces `dist/portal/*` + `dist/sqlui-portal-X.Y.Z.tar.gz`
7. `node scripts/smoke.js` — boots the bundle, probes `/` and `/api/connections`
8. **If submodule pointer changed**: commit + push main. **Always**: create + push tag `vX.Y.Z`.
9. `gh release create vX.Y.Z --target <sha>` with tarball attached

On step 9 failure: the tag is deleted (locally and on origin) so the next run
sees a "no release" state and re-publishes cleanly. The version-bump commit
stays on main — it is safe to leave; we never force-push.

### Flags

- `--sha=<ref>` (default: `main`) — branch / tag / SHA in upstream to release.
  Resolved against `origin/<ref>` first (so `main` always means latest fetched
  main), then as-is (SHA / tag).
- `--dry-run` (default: false) — skip phases 3, 8, 9. PR validation uses this.

## Cadence

- **Cron**: Mondays 13:00 UTC, default `sha=main`. If upstream version is
  unchanged and already cleanly released → skip silently (green).
- **Manual**: `gh workflow run release.yml -f sha=main` (or a tag / SHA).

## Rules

1. **Do not modify `vendor/sqlui-native/`** in this repo. Portal behavior,
   bundle layout, and build logic changes happen upstream — not here. This repo
   changes only when the submodule pointer rolls forward or the release
   machinery (`scripts/release.js`, workflows) needs work.

2. **Do not duplicate logic from upstream.** If you find yourself reaching into
   the submodule to copy a function or script, stop and put the change upstream
   first.

3. **No version of our own.** `package.json` here stays at `0.0.0`. The release
   tag always comes from upstream `package.json`. To force a re-release, bump
   upstream's version.

4. **Squash + auto-merge on PRs** (matches the user's global engineering
   principles).

5. **The `gh release` is created with `--target <sha>`** so it is pinned to the
   exact commit even if `main` moves later.

6. **README has a sentinel block** delimited by `<!-- release-version-block:start -->`
   and `<!-- release-version-block:end -->`. The release script rewrites
   everything between those markers each release so the copy-paste pinned-version
   URLs always match the version being released. **Do not hand-edit the content
   between the markers** — your changes will be overwritten. To change the
   format of the generated block, edit `refreshReadmeVersionBlock()` in
   `scripts/release.js`.

## What lives upstream (not here)

- Adapter implementations, frontend code, sidecar logic, Tauri shell, e2e tests
- `vite.sqlui-portal.config.ts` — the portal Vite config
- `scripts/build-portal.js` upstream — the actual build orchestration
- `src/sqlui-server/portal.ts` — the portal entrypoint
- `scripts/sqlui-portal` upstream — the bash launcher

If any of these need changes, open the PR against `synle/sqlui-native`, merge
there, then trigger a new release here.

## Local development

```sh
# One-time setup after clone
git submodule update --init --recursive

# Dry-run a release (test + build + smoke, no push)
node scripts/release.js --dry-run

# Smoke-test an already-built bundle
node scripts/smoke.js

# Release a specific upstream SHA (for local experimentation)
node scripts/release.js --sha=abc1234 --dry-run
```
