#!/usr/bin/env node
// What the committed covenant bytecode was built from, checked without a network:
//
//   - one compiler commit everywhere it is named (Cargo.toml, Cargo.lock, tools/vendor.sh);
//   - the sources (the contracts and the KCC-20 reference they import, both in this
//     repository) and the artifacts are the ones bridge/kaspa/artifacts/PROVENANCE.json
//     records, with each contract's bytecode hash;
//   - the builders (run 21, Daybreak [6]): the Rust image tools/rust.sh runs and the one the
//     WebAssembly image starts from, one image named in full and by its digest (a tag can be moved
//     to other bytes, and podman takes a short name only through an alias); every package that
//     image installs at an exact version; and tools/wasm.sh running the image it builds by the ID
//     the build gives, never by a tag.
//
// Recompiling and comparing is the other half: `cargo test --test artifacts` in bridge/kaspa
// for the bytecode, and tools/wasm.sh for the WebAssembly core that embeds it. The CI job runs
// them on a copy of the tree and compares the copy's output with the checkout, which no builder
// mounts (.github/workflows/artifacts.yml).
//
//   node tools/check-artifacts.mjs            check
//   node tools/check-artifacts.mjs --write    record the current state, after a real rebuild
//   node tools/check-artifacts.mjs --upstream also compare the reference with its pinned commit

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const sha = (text) => createHash('sha256').update(text).digest('hex');

const SOURCES = [
  'bridge/kaspa/contracts/kusdt.ag', 'bridge/kaspa/contracts/bridge_mint.ag', 'bridge/kaspa/contracts/pool.ag',
  'vendor/kcc20-reference/contracts/kcc20.ag', 'vendor/kcc20-reference/contracts/token_seed.ag',
];
const ARTIFACTS = ['bridge/kaspa/artifacts/kusdt.json', 'bridge/kaspa/artifacts/pool.json'];
const WASM = ['bridge/packages/core/pkg-web/kusdt_wasm_bg.wasm', 'bridge/packages/core/pkg-node/kusdt_wasm_bg.wasm'];
const PROVENANCE = 'bridge/kaspa/artifacts/PROVENANCE.json';
const REFERENCE = { repo: 'https://github.com/argent-lang/kcc20-reference.git', commit: '27f8403fee55863125b044c73b2c9449d997a6ca' };

const problems = [];

/** The compiler commit, or a problem for every place that names another. */
function compilerCommit() {
  const cargo = read('bridge/kaspa/Cargo.toml');
  const revs = new Set([...cargo.matchAll(/^argent[a-z-]*\s*=\s*\{[^}]*rev\s*=\s*"([0-9a-f]{40})"/gm)].map((m) => m[1]));
  if (revs.size !== 1) problems.push(`bridge/kaspa/Cargo.toml names ${revs.size} compiler commits: ${[...revs].join(', ') || 'none'}`);
  const [rev] = revs;
  const lock = new Set([...read('bridge/kaspa/Cargo.lock').matchAll(/git\+https:\/\/github\.com\/argent-lang\/argent\?rev=([0-9a-f]{40})/g)].map((m) => m[1]));
  if (lock.size !== 1 || !lock.has(rev)) problems.push(`bridge/kaspa/Cargo.lock has the compiler at ${[...lock].join(', ') || 'no commit'}, Cargo.toml at ${rev}`);
  const vendored = /fetch argent \S+ ([0-9a-f]{40})/.exec(read('tools/vendor.sh'))?.[1];
  if (vendored !== rev) problems.push(`tools/vendor.sh has the compiler at ${vendored}, Cargo.toml at ${rev}`);
  return rev;
}

/** Each contract's bytecode, by hash, from the artifacts. */
function bytecodes() {
  const out = {};
  for (const path of ARTIFACTS) {
    const contracts = JSON.parse(read(path)).sil_abi?.contracts ?? {};
    for (const [name, c] of Object.entries(contracts)) out[`${path.split('/').pop().replace('.json', '')}/${name}`] = sha(JSON.stringify(c.compiled?.bytecode));
  }
  return out;
}

/** The builders' images and packages, pinned, or a problem for each that is not; the image, for the record. */
function builders() {
  const rust = read('tools/rust.sh'), dockerfile = read('tools/docker/rust-wasm.Dockerfile'), wasm = read('tools/wasm.sh');
  // A registry's host first (docker.io/library/rust, not rust): podman resolves a short name only through an alias.
  const byDigest = /^[a-z0-9-]+(\.[a-z0-9-]+)+\/[a-z0-9._/-]+:[\w.-]+@sha256:[0-9a-f]{64}$/;
  const runs = [...rust.matchAll(/^\s+(\S+) "\$@"$/gm)].map((m) => m[1]);
  const from = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  if (runs.length !== 1 || !byDigest.test(runs[0])) problems.push(`tools/rust.sh runs ${runs.join(', ') || 'no image found'}: name its image in full and by its digest (docker.io/library/rust:<tag>@sha256:...)`);
  for (const f of from) if (!byDigest.test(f)) problems.push(`tools/docker/rust-wasm.Dockerfile starts from ${f}: name it in full and by its digest`);
  if (runs.length === 1 && (from.length !== 1 || from[0] !== runs[0])) problems.push(`tools/docker/rust-wasm.Dockerfile starts from ${from.join(', ') || 'nothing'}, and tools/rust.sh runs ${runs[0]}: one toolchain for both`);
  const packages = [...dockerfile.matchAll(/apt-get install([^&]*)/g)].flatMap((m) => m[1].split(/\s+/).filter((w) => w && w !== '\\' && !w.startsWith('-')));
  for (const p of packages) if (!/^[a-z0-9.+-]+=\S+$/.test(p)) problems.push(`tools/docker/rust-wasm.Dockerfile installs ${p} at whatever version apt serves: name it (${p}=<version>)`);
  if (!/^image="\$\(docker build -q /m.test(wasm) || !/^\s+"\$image" sh -c/m.test(wasm)) problems.push('tools/wasm.sh must run the image it builds from tools/docker/rust-wasm.Dockerfile by the ID that build gives (image="$(docker build -q ...)", then "$image"), never by a tag');
  return { image: runs[0], packages: packages.length };
}

const state = () => ({
  note: 'Written by tools/check-artifacts.mjs --write after a rebuild. What the committed covenant bytecode was built from.',
  compiler: { repo: 'https://github.com/argent-lang/argent', commit: compilerCommit(), generator: JSON.parse(read(ARTIFACTS[0])).generator },
  toolchain: /channel\s*=\s*"([^"]+)"/.exec(read('bridge/kaspa/rust-toolchain.toml'))?.[1],
  kcc20Reference: REFERENCE,
  sources: Object.fromEntries(SOURCES.map((p) => [p, sha(read(p))])),
  artifacts: Object.fromEntries(ARTIFACTS.map((p) => [p, sha(read(p))])),
  wasm: Object.fromEntries(WASM.map((p) => [p, sha(readFileSync(join(root, p)))])),
  bytecode: bytecodes(),
});

const built = builders();

if (process.argv.includes('--write')) {
  const now = state();
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  writeFileSync(join(root, PROVENANCE), JSON.stringify(now, null, 2) + '\n');
  console.log(`wrote ${PROVENANCE}`);
  process.exit(0);
}

const recorded = JSON.parse(read(PROVENANCE));
const now = state();
for (const key of ['compiler', 'toolchain', 'kcc20Reference', 'sources', 'artifacts', 'wasm', 'bytecode']) {
  const a = JSON.stringify(recorded[key]), b = JSON.stringify(now[key]);
  if (a !== b) {
    if (typeof recorded[key] === 'object' && recorded[key]) {
      for (const k of new Set([...Object.keys(recorded[key]), ...Object.keys(now[key])])) {
        if (JSON.stringify(recorded[key][k]) !== JSON.stringify(now[key][k])) problems.push(`${key}.${k}: recorded ${JSON.stringify(recorded[key][k])}, found ${JSON.stringify(now[key][k])}`);
      }
    } else problems.push(`${key}: recorded ${a}, found ${b}`);
  }
}

if (process.argv.includes('--upstream')) {
  const dir = mkdtempSync(join(tmpdir(), 'kcc20-reference-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    git('init', '-q');
    git('fetch', '-q', '--depth', '1', REFERENCE.repo, REFERENCE.commit);
    for (const name of ['kcc20.ag', 'token_seed.ag']) {
      const theirs = git('show', `FETCH_HEAD:contracts/${name}`).replace(/\r\n/g, '\n');
      if (theirs !== read(`vendor/kcc20-reference/contracts/${name}`)) problems.push(`vendor/kcc20-reference/contracts/${name} differs from ${REFERENCE.commit}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (problems.length) {
  console.error(`The committed bytecode's record does not hold:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`ok: compiler ${now.compiler.commit.slice(0, 7)}, ${SOURCES.length} sources, ${ARTIFACTS.length} artifacts, ${Object.keys(now.bytecode).length} contracts' bytecode; builders pinned (${built.image}, ${built.packages} packages by version)`);
