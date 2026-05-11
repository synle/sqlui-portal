#!/usr/bin/env node
/**
 * sqlui-portal release coordinator.
 *
 * This is the ONLY meaningful script in this repo. It runs identically locally
 * and from .github/workflows/release.yml — the workflow file just forwards its
 * dispatch inputs to this script.
 *
 * Design choices:
 *   - sqlui-portal has NO version of its own. The release tag (vX.Y.Z) is
 *     sourced from vendor/sqlui-native/package.json at the resolved --sha.
 *     To re-release the same upstream code with new changes, upstream MUST
 *     bump its package.json version first.
 *   - Skip-when-published-cleanly: if a release for the upstream version
 *     already exists AND has a .tar.gz asset, exit 0 (logged as "skip",
 *     surfaces green in CI — not an error).
 *   - Auto-cleanup-when-broken: if a release exists but has no assets
 *     (half-baked from a prior failure), delete it and re-release. Likewise
 *     for orphan tags with no release.
 *
 * Phases (the push is the LAST thing, so failures before it leave origin
 * untouched):
 *
 *   1. Fetch + checkout --sha in vendor/sqlui-native (default: origin/main)
 *   2. Read upstream version → tag = vX.Y.Z
 *   3. Inspect existing release/tag for vX.Y.Z:
 *        - clean (has assets) → SKIP, exit 0
 *        - broken (no assets) → delete release + tag, proceed
 *        - no release / orphan tag → delete tag if any, proceed
 *   4. cd vendor/sqlui-native && npm ci
 *   5. npm run test-ci  (upstream's test suite — gates the bundle)
 *   6. npm run build:portal
 *   7. scripts/smoke.js  (boots the bundle, probes /, /api/connections)
 *   8. Commit submodule pointer (if changed) + push main + tag + push tag
 *   9. gh release create vX.Y.Z --target <sha> with tarball attached
 *
 * On step 9 failure: tag is deleted (locally + remote) so the next run sees a
 * "no release" state and re-publishes cleanly. The version-bump commit (if
 * any) stays on main — safe to leave; never force-push.
 *
 * Flags:
 *   --sha=<ref>       default: main     branch / tag / SHA in upstream to release
 *   --dry-run         default: false    skip phases 8 and 9 (for PR validation)
 *
 * CI integration: writes key=value lines to $GITHUB_OUTPUT (skipped, version,
 * upstream_sha, tar_path) and a human-readable summary to $GITHUB_STEP_SUMMARY.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SUBMODULE = path.join(ROOT, "vendor", "sqlui-native");
const REPO = "synle/sqlui-portal";

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { sha: "main", dryRun: false };
  for (const arg of argv) {
    const [k, v] = arg.includes("=") ? arg.split("=") : [arg, "true"];
    switch (k) {
      case "--sha":
        if (!v) throw new Error(`--sha requires a value`);
        opts.sha = v;
        break;
      case "--dry-run":
        opts.dryRun = v === "true";
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[release] ${msg}`);
}

function run(cmd, args, cwd = ROOT) {
  log(`$ ${cmd} ${args.join(" ")}  (cwd=${path.relative(ROOT, cwd) || "."})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function capture(cmd, args, cwd = ROOT) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function tryCapture(cmd, args, cwd = ROOT) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function setOutput(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) fs.appendFileSync(f, `${key}=${value}\n`);
  log(`output: ${key}=${value}`);
}

function appendSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, md + "\n");
}

/**
 * Regenerates the pinned-version block in README.md so copy-paste URLs always
 * reflect the version being released. The block is delimited by sentinel
 * comments; everything between them is replaced atomically.
 *
 * Returns true if README.md was actually modified.
 */
function refreshReadmeVersionBlock(version) {
  const readmePath = path.join(ROOT, "README.md");
  const START = "<!-- release-version-block:start -->";
  const END = "<!-- release-version-block:end -->";
  const original = fs.readFileSync(readmePath, "utf-8");
  const startIdx = original.indexOf(START);
  const endIdx = original.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    log(`WARN: README sentinel markers not found — skipping README version refresh`);
    return false;
  }
  const tag = `v${version}`;
  const newBlock =
    `${START}\n` +
    `**Latest:** \`${tag}\`\n\n` +
    "```sh\n" +
    `# curl + tar\n` +
    `curl -fsSL https://github.com/synle/sqlui-portal/releases/download/${tag}/sqlui-portal-${version}.tar.gz | tar -xz && ./portal/sqlui-portal\n\n` +
    `# npx\n` +
    `npx https://github.com/synle/sqlui-portal/releases/download/${tag}/sqlui-portal-${version}.tar.gz\n` +
    "```\n" +
    END;
  const updated = original.slice(0, startIdx) + newBlock + original.slice(endIdx + END.length);
  if (updated === original) return false;
  fs.writeFileSync(readmePath, updated);
  return true;
}

/**
 * Resolves --sha input to a concrete upstream commit SHA.
 * Tries `origin/<input>` first (so `main` always means latest fetched main),
 * then falls back to treating input as a SHA or tag.
 */
function resolveUpstreamRef(input) {
  const asBranch = tryCapture("git", ["-C", SUBMODULE, "rev-parse", `origin/${input}`]);
  if (asBranch) return asBranch;
  const asIs = tryCapture("git", ["-C", SUBMODULE, "rev-parse", `${input}^{commit}`]);
  if (asIs) return asIs;
  throw new Error(`could not resolve --sha=${input} as a branch, tag, or commit in upstream`);
}

/**
 * Inspects the current state of a release tag on this repo's GitHub.
 * Returns one of:
 *   { kind: "clean", assets: [...] }      tag + release + at least one asset
 *   { kind: "broken-release" }            tag + release exists but no assets
 *   { kind: "orphan-tag" }                tag exists, no release
 *   { kind: "none" }                      nothing exists
 */
function inspectRelease(tag) {
  // Prefer `gh release view` — it tells us about both the release and its assets.
  const r = spawnSync("gh", ["release", "view", tag, "--repo", REPO, "--json", "assets,tagName"], { encoding: "utf-8" });
  if (r.status === 0) {
    const data = JSON.parse(r.stdout);
    const assets = data.assets || [];
    return assets.length > 0 ? { kind: "clean", assets } : { kind: "broken-release" };
  }
  // No release. Is there an orphan tag on the remote?
  const tagRef = tryCapture("git", ["ls-remote", "origin", `refs/tags/${tag}`]);
  if (tagRef) return { kind: "orphan-tag" };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  log(`opts: ${JSON.stringify(opts)}`);

  // Phase 0: sanity
  if (!fs.existsSync(path.join(SUBMODULE, "package.json"))) {
    throw new Error(`Submodule not initialized at ${SUBMODULE}. Run: git submodule update --init --recursive`);
  }

  // Phase 1: fetch + checkout upstream ref
  log(`fetching upstream …`);
  run("git", ["-C", SUBMODULE, "fetch", "origin", "--tags", "--prune"]);
  const upstreamSha = resolveUpstreamRef(opts.sha);
  log(`resolved --sha=${opts.sha} → ${upstreamSha}`);
  run("git", ["-C", SUBMODULE, "-c", "advice.detachedHead=false", "checkout", "--detach", upstreamSha]);

  // Phase 2: read upstream version → tag
  const upstreamPkg = readJson(path.join(SUBMODULE, "package.json"));
  const version = upstreamPkg.version;
  const tag = `v${version}`;
  log(`upstream version: ${version} → release tag: ${tag}`);
  setOutput("version", version);
  setOutput("upstream_sha", upstreamSha);

  // Phase 3: inspect existing release state
  if (!opts.dryRun) {
    log(`inspecting existing release ${tag} on ${REPO} …`);
    const state = inspectRelease(tag);
    log(`release state: ${state.kind}`);

    if (state.kind === "clean") {
      const msg = `${tag} is already published with ${state.assets.length} asset(s) — nothing to do.`;
      log(`[skip] ${msg}`);
      log(`To re-release, upstream sqlui-native must bump its package.json version first.`);
      setOutput("skipped", "true");
      appendSummary(`### ⏭ Skipped: ${tag}\n\n${msg}\n\nTo re-release, upstream \`sqlui-native\` must bump its \`package.json\` version first.`);
      return;
    }

    if (state.kind === "broken-release") {
      log(`cleaning up broken release ${tag} (no assets attached) …`);
      run("gh", ["release", "delete", tag, "--repo", REPO, "--cleanup-tag", "--yes"]);
    } else if (state.kind === "orphan-tag") {
      log(`cleaning up orphan tag ${tag} (no release attached) …`);
      run("git", ["push", "origin", `:refs/tags/${tag}`]);
    }
    setOutput("skipped", "false");
  }

  // Phase 4 + 5 + 6: build inside submodule
  log(`installing submodule dependencies …`);
  run("npm", ["ci"], SUBMODULE);
  log(`running upstream test suite …`);
  run("npm", ["run", "test-ci"], SUBMODULE);
  log(`building portal bundle …`);
  run("npm", ["run", "build:portal"], SUBMODULE);

  // Locate the tarball and surface it under our dist/
  const upstreamTar = path.join(SUBMODULE, "dist", `sqlui-portal-${version}.tar.gz`);
  if (!fs.existsSync(upstreamTar)) {
    throw new Error(`expected tarball not found: ${upstreamTar}`);
  }
  const ourDist = path.join(ROOT, "dist");
  fs.mkdirSync(ourDist, { recursive: true });
  // We attach TWO copies of the same tarball to the release:
  //   - sqlui-portal-X.Y.Z.tar.gz  : versioned, for users who want to pin
  //   - sqlui-portal.tar.gz        : stable name, resolvable via
  //                                  /releases/latest/download/sqlui-portal.tar.gz
  // This gives users a stable URL they can curl/npx without knowing the version.
  const ourTarVersioned = path.join(ourDist, `sqlui-portal-${version}.tar.gz`);
  const ourTarStable = path.join(ourDist, "sqlui-portal.tar.gz");
  fs.copyFileSync(upstreamTar, ourTarVersioned);
  fs.copyFileSync(upstreamTar, ourTarStable);
  // Mirror the unpacked dist/portal/ for smoke + local inspection
  const upstreamPortalDir = path.join(SUBMODULE, "dist", "portal");
  if (fs.existsSync(upstreamPortalDir)) {
    const ourPortalDir = path.join(ourDist, "portal");
    fs.rmSync(ourPortalDir, { recursive: true, force: true });
    fs.cpSync(upstreamPortalDir, ourPortalDir, { recursive: true });
  }
  setOutput("tar_path", path.relative(ROOT, ourTarVersioned));
  log(`tarball: ${path.relative(ROOT, ourTarVersioned)} (${(fs.statSync(ourTarVersioned).size / 1024 / 1024).toFixed(2)} MB)`);
  log(`stable: ${path.relative(ROOT, ourTarStable)}`);

  // Phase 7: smoke test
  log(`smoke testing built bundle …`);
  run("node", [path.join(ROOT, "scripts", "smoke.js")], ROOT);

  if (opts.dryRun) {
    log(`--dry-run set — skipping phases 8 & 9. Working tree changes left in place.`);
    appendSummary(`### 🧪 Dry-run OK: ${tag}\n\nTest + build + smoke succeeded for upstream \`${upstreamSha.slice(0, 7)}\`. No push, no release.`);
    return;
  }

  // Phase 8: refresh README + commit (if anything changed) + push + tag + push tag
  log(`refreshing README pinned-version block …`);
  const readmeChanged = refreshReadmeVersionBlock(version);
  const submoduleDirty = !!tryCapture("git", ["status", "--porcelain", "vendor/sqlui-native"]);
  if (submoduleDirty || readmeChanged) {
    const shortSha = upstreamSha.slice(0, 7);
    const commitMsg =
      `chore(release): ${tag} (sqlui-native @ ${shortSha})\n\n` +
      `Pins vendor/sqlui-native to ${shortSha} (upstream ${tag}).\n` +
      (readmeChanged ? `Refreshes pinned-version URLs in README to ${tag}.\n` : "");
    log(`committing release artifacts (submodule=${submoduleDirty}, readme=${readmeChanged}) …`);
    if (submoduleDirty) run("git", ["add", "vendor/sqlui-native"]);
    if (readmeChanged) run("git", ["add", "README.md"]);
    run("git", ["commit", "-m", commitMsg]);
    log(`pushing main …`);
    run("git", ["push", "origin", "HEAD:main"]);
  } else {
    log(`nothing changed (submodule + README both clean) — tagging current main HEAD`);
  }

  const commitSha = capture("git", ["rev-parse", "HEAD"]);
  log(`tagging ${tag} at ${commitSha} …`);
  run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
  run("git", ["push", "origin", tag]);

  // Phase 9: GH release
  try {
    log(`creating GitHub release ${tag} …`);
    const notes =
      `Portal bundle of [sqlui-native ${tag}](https://github.com/synle/sqlui-native/commit/${upstreamSha}).\n\n` +
      `### Install — latest\n\n` +
      "```sh\n" +
      `# curl + tar\n` +
      `curl -fsSL https://github.com/synle/sqlui-portal/releases/latest/download/sqlui-portal.tar.gz | tar -xz && ./portal/sqlui-portal\n\n` +
      `# npx\n` +
      `npx https://github.com/synle/sqlui-portal/releases/latest/download/sqlui-portal.tar.gz\n` +
      "```\n\n" +
      `### Install — pinned to ${tag}\n\n` +
      "```sh\n" +
      `curl -fsSL https://github.com/synle/sqlui-portal/releases/download/${tag}/sqlui-portal-${version}.tar.gz | tar -xz && ./portal/sqlui-portal\n` +
      `npx https://github.com/synle/sqlui-portal/releases/download/${tag}/sqlui-portal-${version}.tar.gz\n` +
      "```\n";
    run("gh", ["release", "create", tag, ourTarVersioned, ourTarStable, "--repo", REPO, "--target", commitSha, "--title", tag, "--notes", notes]);
    log(`release ${tag} published`);
    appendSummary(`### ✅ Released: ${tag}\n\nUpstream: \`sqlui-native@${upstreamSha.slice(0, 7)}\`\nArtifacts: \`${path.basename(ourTarVersioned)}\`, \`${path.basename(ourTarStable)}\``);
  } catch (err) {
    console.error(`[release] release creation failed; deleting tag so the next run can retry cleanly`);
    spawnSync("git", ["push", "origin", `:refs/tags/${tag}`], { cwd: ROOT, stdio: "inherit" });
    spawnSync("git", ["tag", "-d", tag], { cwd: ROOT, stdio: "inherit" });
    throw err;
  }
}

main().catch((err) => {
  console.error(`[release] FAILED: ${err.message}`);
  process.exit(1);
});
