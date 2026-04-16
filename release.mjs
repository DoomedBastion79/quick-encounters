#!/usr/bin/env node
// Publishes a GitHub Release for the Quick Encounters Foundry module.
//
// Workflow:
//   1. Preflight: verify `gh` is installed + authenticated, the working tree
//      is clean, and module.json is readable.
//   2. Optional --bump patch|minor|major writes a new version into module.json.
//   3. Package the module into <repo>/dist/quick-encounters.zip. The zip
//      excludes .git/, dist/, the release script itself, and the usual
//      development artifacts (TODO, TESTING.md, etc.).
//   4. Stage <repo>/dist/module.json next to the zip (the asset URL
//      /releases/latest/download/module.json must resolve to a plain file
//      named exactly module.json, not a versioned filename).
//   5. Push the current branch, create+push the git tag, then create a
//      GitHub Release flagged --latest with both assets attached. If the
//      tag already exists we re-upload assets with --clobber.
//
// Usage:
//   node release.mjs                    # release current version in module.json
//   node release.mjs --dry-run          # show what would happen
//   node release.mjs --bump patch       # 14.0.2 -> 14.0.3
//   node release.mjs --bump minor       # 14.0.2 -> 14.1.0
//   node release.mjs --bump major       # 14.0.2 -> 15.0.0
//   node release.mjs --notes "Fix X"    # custom release notes (default: last 5 commits)
//   node release.mjs --title "..."      # custom release title
//   node release.mjs --allow-dirty      # proceed even with unstaged changes
//
// Requirements:
//   - `gh` CLI installed and authenticated (`gh auth login`)
//   - Git clean working tree (or --allow-dirty)
//   - Network access to github.com

import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODULE_ROOT = __dirname;
const DIST_DIR = path.join(MODULE_ROOT, "dist");
const MODULE_JSON_PATH = path.join(MODULE_ROOT, "module.json");

// Files and directories that should never land inside the distribution zip.
// Everything else under MODULE_ROOT is included recursively.
const ZIP_EXCLUDE_DIRS = new Set([
  ".git",
  "dist",
  "node_modules",
]);
const ZIP_EXCLUDE_FILES = new Set([
  "release.mjs",
  "TODO",
  "TESTING.md",
  ".gitignore",
  ".DS_Store",
]);

// ---- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`⚔   Quick Encounters releaser`);
  console.log();

  if (!args.dryRun) await checkGhCli();
  await checkGitClean(args.allowDirty);
  const manifest = await readManifest();

  if (args.bump) {
    const newVersion = bumpVersion(manifest.version, args.bump);
    console.log(`🔖  Bumping version: ${manifest.version} -> ${newVersion}`);
    manifest.version = newVersion;
    await writeManifest(manifest);
  }

  const version = manifest.version;
  const id = manifest.id || manifest.name || "quick-encounters";
  const tag = `v${version}`;
  console.log(`📋  Module: ${id} v${version}`);
  console.log(`    Tag:    ${tag}`);
  console.log();

  if (args.dryRun) {
    console.log(`🌵  --dry-run: exiting before any mutations`);
    return;
  }

  // Package
  await fs.mkdir(DIST_DIR, { recursive: true });
  const zipPath = path.join(DIST_DIR, `${id}.zip`);
  console.log(`📦  Packaging ${path.relative(MODULE_ROOT, zipPath)}`);
  await buildZip(MODULE_ROOT, zipPath, id);
  const { size } = await fs.stat(zipPath);
  console.log(`    ${formatBytes(size)}`);
  console.log();

  // Stage a copy of module.json at dist/module.json so the asset URL
  // /releases/latest/download/module.json works.
  const manifestAsset = path.join(DIST_DIR, "module.json");
  await fs.copyFile(MODULE_JSON_PATH, manifestAsset);

  // Push current branch, then tag
  console.log(`⬆   Pushing current branch to origin`);
  await git(["push"]);
  await ensureTagPushed(tag);

  // Release
  const title = args.title || `Quick Encounters ${tag}`;
  const notes = args.notes || (await buildAutoNotes(version));
  await createOrUpdateRelease({
    tag,
    title,
    notes,
    assets: [zipPath, manifestAsset],
  });

  const repo = await getGhRepo();
  console.log();
  console.log(`✅  Release published: ${tag}`);
  console.log(`    https://github.com/${repo}/releases/tag/${tag}`);
  console.log();
  console.log(`Foundry will now pick up the update at:`);
  console.log(`  https://github.com/${repo}/releases/latest/download/module.json`);
}

// ---- preflight -------------------------------------------------------------

async function checkGhCli() {
  try {
    await gh(["--version"], { silent: true });
  } catch {
    throw new Error(
      "`gh` CLI not found on PATH. Install from https://cli.github.com/ " +
        "and run `gh auth login` before releasing.",
    );
  }
  try {
    await gh(["auth", "status"], { silent: true });
  } catch {
    throw new Error(
      "gh CLI is installed but not authenticated. Run `gh auth login` first.",
    );
  }
}

async function checkGitClean(allowDirty) {
  const { stdout } = await git(["status", "--porcelain"], { silent: true });
  if (stdout.trim().length === 0) return;
  if (allowDirty) {
    console.log(`⚠   Working tree not clean, continuing (--allow-dirty)`);
    return;
  }
  throw new Error(
    `Git working tree is not clean. Commit or stash your changes, or ` +
      `re-run with --allow-dirty.\n\n${stdout}`,
  );
}

// ---- manifest --------------------------------------------------------------

async function readManifest() {
  const raw = await fs.readFile(MODULE_JSON_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeManifest(manifest) {
  const raw = JSON.stringify(manifest, null, 2) + "\n";
  await fs.writeFile(MODULE_JSON_PATH, raw, "utf8");
}

function bumpVersion(version, kind) {
  const parts = String(version || "0.0.0").split(".").map((n) => parseInt(n, 10));
  while (parts.length < 3) parts.push(0);
  switch (kind) {
    case "major": parts[0] += 1; parts[1] = 0; parts[2] = 0; break;
    case "minor": parts[1] += 1; parts[2] = 0; break;
    case "patch": parts[2] += 1; break;
    default: throw new Error(`Unknown bump kind: ${kind} (use major|minor|patch)`);
  }
  return parts.join(".");
}

// ---- zip packaging ---------------------------------------------------------

/**
 * Walk MODULE_ROOT and collect every file that belongs in the distribution
 * zip, as { absPath, zipPath } pairs. zipPath is the relative path with the
 * module id as its root directory — matching what existing Quick Encounters
 * releases shipped so Foundry unpacks it into the correct folder.
 */
async function collectFiles(root, zipRoot) {
  const out = [];
  async function walk(dir, relDir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ZIP_EXCLUDE_DIRS.has(entry.name)) continue;
        await walk(abs, relDir ? `${relDir}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        if (ZIP_EXCLUDE_FILES.has(entry.name)) continue;
        const zipPath = `${zipRoot}/${relDir ? `${relDir}/` : ""}${entry.name}`;
        out.push({ absPath: abs, zipPath });
      }
    }
  }
  await walk(root, "");
  return out;
}

/**
 * Build the module zip. Prefers the system `zip` binary (faster, no deps),
 * falls back to a pure-JS implementation if it's missing.
 */
async function buildZip(root, outPath, zipRoot) {
  await fs.rm(outPath, { force: true });

  // Try the system `zip` binary. It's the fastest option and produces a
  // standard archive with a single top-level directory named after the
  // module, which is what Foundry's module installer expects.
  if (await hasSystemZip()) {
    await buildZipViaSystemCli(root, outPath, zipRoot);
    return;
  }

  // Fallback: node-only implementation using no-compression store entries.
  // Slightly larger than a deflate zip but fine for distribution.
  await buildZipViaNode(root, outPath, zipRoot);
}

async function hasSystemZip() {
  try {
    await run("zip", ["--version"], { silent: true });
    return true;
  } catch {
    return false;
  }
}

async function buildZipViaSystemCli(root, outPath, zipRoot) {
  // We want the archive to contain <zipRoot>/... entries (not ./... entries),
  // so stage a symlink in a scratch directory and zip from there. Keeps the
  // on-disk structure untouched.
  const stageDir = await fs.mkdtemp(path.join(DIST_DIR, ".stage-"));
  const linkPath = path.join(stageDir, zipRoot);
  try {
    await fs.symlink(root, linkPath, "dir");
    const excludeArgs = [];
    // Directories are excluded at any depth under zipRoot.
    for (const d of ZIP_EXCLUDE_DIRS) {
      excludeArgs.push("-x", `${zipRoot}/${d}/*`);
      excludeArgs.push("-x", `${zipRoot}/*/${d}/*`);
    }
    // Files are excluded at any depth — .DS_Store and friends tend to appear
    // beside content, not just at the root.
    for (const f of ZIP_EXCLUDE_FILES) {
      excludeArgs.push("-x", `${zipRoot}/${f}`);
      excludeArgs.push("-x", `${zipRoot}/*/${f}`);
      excludeArgs.push("-x", `${zipRoot}/**/${f}`);
    }
    await run(
      "zip",
      ["-r", "-q", outPath, zipRoot, ...excludeArgs],
      { cwd: stageDir },
    );
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

/**
 * Pure-node zip writer (STORE entries only — no compression). Enough for a
 * fallback when the system `zip` binary isn't available; Foundry handles
 * both stored and deflated entries identically.
 */
async function buildZipViaNode(root, outPath, zipRoot) {
  const files = await collectFiles(root, zipRoot);
  const chunks = [];
  const central = [];
  let offset = 0;

  const crc32 = await getCrc32();

  for (const { absPath, zipPath } of files) {
    const data = await fs.readFile(absPath);
    const name = Buffer.from(zipPath, "utf8");
    const crc = crc32(data);
    const size = data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);          // version needed
    localHeader.writeUInt16LE(0x0800, 6);      // gpbf: UTF-8 names
    localHeader.writeUInt16LE(0, 8);           // method: store
    localHeader.writeUInt16LE(0, 10);          // mtime (unused)
    localHeader.writeUInt16LE(0, 12);          // mdate (unused)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);          // extra length
    chunks.push(localHeader, name, data);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);         // version made by
    centralEntry.writeUInt16LE(20, 6);         // version needed
    centralEntry.writeUInt16LE(0x0800, 8);     // gpbf
    centralEntry.writeUInt16LE(0, 10);
    centralEntry.writeUInt16LE(0, 12);
    centralEntry.writeUInt16LE(0, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(size, 20);
    centralEntry.writeUInt32LE(size, 24);
    centralEntry.writeUInt16LE(name.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38);         // external attrs
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const stream = createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.on("finish", resolve);
    for (const chunk of chunks) stream.write(chunk);
    stream.write(centralBuf);
    stream.write(eocd);
    stream.end();
  });
}

/** Lazy CRC-32 using node's built-in zlib if available, else a table-based fallback. */
async function getCrc32() {
  try {
    const require = createRequire(import.meta.url);
    const zlib = require("node:zlib");
    if (typeof zlib.crc32 === "function") {
      return (buf) => zlib.crc32(buf) >>> 0;
    }
  } catch { /* ignore */ }
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
}

// ---- git tag ---------------------------------------------------------------

async function ensureTagPushed(tag) {
  const { stdout: localTags } = await git(["tag", "--list", tag], { silent: true });
  if (!localTags.trim()) {
    console.log(`🏷   Creating tag ${tag}`);
    await git(["tag", "-a", tag, "-m", `Release ${tag}`]);
  } else {
    console.log(`🏷   Tag ${tag} already exists locally`);
  }
  console.log(`⬆   Pushing tag ${tag} to origin`);
  await git(["push", "origin", tag]);
}

// ---- gh release ------------------------------------------------------------

let _ghRepo = null;
async function getGhRepo() {
  if (_ghRepo) return _ghRepo;
  try {
    const { stdout } = await git(["remote", "get-url", "origin"], { silent: true });
    const m = stdout.trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) _ghRepo = `${m[1]}/${m[2]}`;
  } catch { /* ignore */ }
  if (!_ghRepo) _ghRepo = "DoomedBastion79/quick-encounters";
  return _ghRepo;
}

async function createOrUpdateRelease({ tag, title, notes, assets }) {
  const repo = await getGhRepo();
  let exists = false;
  try {
    await gh(["-R", repo, "release", "view", tag], { silent: true });
    exists = true;
  } catch { /* release doesn't exist yet */ }

  if (exists) {
    console.log(`🔁  Release ${tag} already exists — updating assets`);
    await gh(["-R", repo, "release", "upload", tag, ...assets, "--clobber"]);
    await gh(["-R", repo, "release", "edit", tag, "--latest"]);
  } else {
    console.log(`🚀  Creating release ${tag}`);
    await gh([
      "-R", repo,
      "release", "create", tag,
      ...assets,
      "--title", title,
      "--notes", notes,
      "--latest",
    ]);
  }
}

async function buildAutoNotes(version) {
  try {
    const { stdout } = await git(["log", "-5", "--pretty=format:- %s"], { silent: true });
    const body = stdout.trim();
    if (body.length > 0) {
      return `## Quick Encounters v${version}\n\nRecent changes:\n${body}\n`;
    }
  } catch { /* ignore */ }
  return `## Quick Encounters v${version}\n\nAutomated release.\n`;
}

// ---- subprocess helpers ----------------------------------------------------

function git(args, opts) {
  return run("git", args, { ...opts, cwd: MODULE_ROOT, shell: false });
}

function gh(args, opts) {
  return run("gh", args, { ...opts, shell: false });
}

function run(cmd, args, { silent = false, cwd, shell } = {}) {
  const useShell = shell ?? (process.platform === "win32");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: silent ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: useShell,
    });
    let stdout = "";
    let stderr = "";
    if (silent) {
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.stderr.on("data", (c) => (stderr += c.toString()));
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}\n${stderr}`));
    });
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

// ---- args ------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dryRun: false,
    allowDirty: false,
    bump: null,
    notes: null,
    title: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run": args.dryRun = true; break;
      case "--allow-dirty": args.allowDirty = true; break;
      case "--bump": args.bump = argv[++i]; break;
      case "--notes": args.notes = argv[++i]; break;
      case "--title": args.title = argv[++i]; break;
      case "-h": case "--help":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`);
        printHelp();
        process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node release.mjs [options]

Options:
  --dry-run          Show what would happen without creating the release
  --allow-dirty      Continue even if git working tree is dirty
  --bump <kind>      Bump version before releasing (patch|minor|major)
  --notes "..."      Custom release notes (default: last 5 commit subjects)
  --title "..."      Custom release title
  -h, --help         Show this help
`);
}

// ---- entry -----------------------------------------------------------------

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref && entryHref === import.meta.url) {
  main().catch((err) => {
    console.error(`\n✗ Release failed: ${err.message}`);
    process.exit(1);
  });
}

export { main };
