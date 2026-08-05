import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, TestContext } from "node:test";

import { createLocalCache } from "./localCache.js";
import { warnings } from "./testHelpers.js";
import { GhCache } from "./utils.js";

const KEY = "v1-rust-abcdef";
const RESTORE_KEYS = ["v1-rust-"];

/**
 * A temp root holding a `cache` directory and a fake `CARGO_HOME`, removed when the test ends.
 * The cache is constructed with an explicit environment so the root table is deterministic.
 */
async function sandbox(t: TestContext, envOverrides: NodeJS.ProcessEnv = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "local-cache-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const cargoHome = path.join(root, "cargo");
  const workspace = path.join(root, "work");
  const cacheDir = path.join(root, "cache");
  await fs.promises.mkdir(cargoHome, { recursive: true });
  await fs.promises.mkdir(workspace, { recursive: true });

  const env = { CARGO_HOME: cargoHome, GITHUB_WORKSPACE: workspace, ...envOverrides };
  return { root, cargoHome, workspace, cacheDir, env, cache: createLocalCache(cacheDir, env) };
}

/** Every file below `dir`, as `relative path -> contents`. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
  const tree = new Map<string, string>();
  for (const entry of entries) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isFile()) {
      tree.set(path.relative(dir, file), await fs.promises.readFile(file, "utf8"));
    }
  }
  return tree;
}

async function writeTree(dir: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, contents);
  }
}

test("a save/restore round trip reproduces the tree", async (t) => {
  const { cargoHome, cache } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");
  await writeTree(tree, {
    "cache/app": "a binary\n",
    "src/deps/lib.rlib": "x".repeat(5000),
    ".rustc_info.json": '{"a":1}\n',
    "nested/deeply/placed/file.txt": "nested\n",
  });
  const before = await snapshot(tree);

  assert.equal(typeof (await cache.saveCache([tree], KEY)), "number");
  await fs.promises.rm(tree, { recursive: true });
  assert.equal(await cache.restoreCache([tree], KEY), KEY);

  assert.deepEqual(await snapshot(tree), before);
  assert.equal(before.size, 4);
});

test("an entry is a directory of per-root archives named by token", async (t) => {
  const { cargoHome, workspace, cacheDir, cache } = await sandbox(t);
  await writeTree(path.join(cargoHome, "registry"), { "a.txt": "a" });
  await writeTree(path.join(workspace, "target"), { "b.txt": "b" });

  await cache.saveCache([path.join(cargoHome, "registry"), path.join(workspace, "target")], KEY);

  assert.deepEqual((await fs.promises.readdir(path.join(cacheDir, KEY))).sort(), [
    "cargo.tar.zst",
    "workspace.tar.zst",
  ]);
});

/**
 * The reason this branch exists. An entry saved with one CARGO_HOME must restore under a
 * different CARGO_HOME, because the cache key never covered the workspace layout.
 */
test("relocation: an entry restores under a different root than it was saved from", async (t) => {
  const { root, cargoHome, cacheDir } = await sandbox(t);
  const saved = path.join(cargoHome, "registry");
  await writeTree(saved, { "index/a.crate": "crate bytes", "cache/b.crate": "more bytes" });
  const before = await snapshot(saved);

  await createLocalCache(cacheDir, { CARGO_HOME: cargoHome }).saveCache([saved], KEY);
  await fs.promises.rm(saved, { recursive: true });

  // A second machine: same key, different CARGO_HOME.
  const otherCargo = path.join(root, "other-cargo");
  const target = path.join(otherCargo, "registry");
  const restored = await createLocalCache(cacheDir, { CARGO_HOME: otherCargo }).restoreCache([target], KEY);

  assert.equal(restored, KEY);
  assert.deepEqual(await snapshot(target), before);
  assert.equal(fs.existsSync(saved), false, "nothing may land at the saving machine's path");
});

/**
 * The `home` root, and the longest-prefix rule that keeps `$HOME/.cargo` out of it: `CARGO_HOME`
 * sits *under* `HOME` on a default install, so a table that took the first match rather than the
 * longest would put the whole cargo registry into `home.tar.zst` and lose its relocatability.
 */
test("a path under HOME uses the home root, while $HOME/.cargo still uses the cargo root", async (t) => {
  const { root, cacheDir } = await sandbox(t);
  const home = path.join(root, "home");
  const env = { HOME: home, CARGO_HOME: path.join(home, ".cargo") };
  await writeTree(path.join(home, ".rustup", "toolchains"), { "stable/bin/rustc": "toolchain" });
  await writeTree(path.join(home, ".cargo", "registry"), { "index/a.crate": "crate" });

  const cache = createLocalCache(cacheDir, env);
  await cache.saveCache([path.join(home, ".rustup"), path.join(home, ".cargo", "registry")], KEY);

  assert.deepEqual((await fs.promises.readdir(path.join(cacheDir, KEY))).sort(), [
    "cargo.tar.zst",
    "home.tar.zst",
  ]);

  // A second machine whose HOME *and* CARGO_HOME both sit elsewhere: both archives relocate.
  await fs.promises.rm(home, { recursive: true });
  const otherHome = path.join(root, "other-home");
  const otherCargo = path.join(root, "other-cargo");
  const relocated = createLocalCache(cacheDir, { HOME: otherHome, CARGO_HOME: otherCargo });

  assert.equal(await relocated.restoreCache([otherHome], KEY), KEY);
  assert.equal(
    await fs.promises.readFile(path.join(otherHome, ".rustup", "toolchains", "stable", "bin", "rustc"), "utf8"),
    "toolchain",
  );
  assert.equal(await fs.promises.readFile(path.join(otherCargo, "registry", "index", "a.crate"), "utf8"), "crate");
  assert.equal(fs.existsSync(path.join(otherHome, ".cargo")), false, "the cargo tree may not land under home");
});

test("a path under no known root restores to its own absolute location", async (t) => {
  const { root, cacheDir, env } = await sandbox(t);
  const outside = path.join(root, "outside", "blobs");
  await writeTree(outside, { "a.txt": "a" });

  const cache = createLocalCache(cacheDir, env);
  await cache.saveCache([outside], KEY);
  const [archive] = await fs.promises.readdir(path.join(cacheDir, KEY));
  assert.match(archive!, /^abs-.*\.tar\.zst$/);

  await fs.promises.rm(outside, { recursive: true });
  assert.equal(await cache.restoreCache([outside], KEY), KEY);
  assert.equal(await fs.promises.readFile(path.join(outside, "a.txt"), "utf8"), "a");
});

/**
 * Ruling: anything short of the whole entry is a miss. An earlier revision reported a partial
 * restore as a hit; that made `restore.ts` compute `match === true`, so nothing ever re-saved the
 * entry and a layered stack never reached the layer holding a good copy.
 */
test("an entry that only partly restores here is a miss, not a hit", async (t) => {
  const { cargoHome, workspace, cacheDir, env } = await sandbox(t);
  await writeTree(path.join(cargoHome, "registry"), { "a.txt": "a" });
  await writeTree(path.join(workspace, "target"), { "b.txt": "b" });
  await createLocalCache(cacheDir, env).saveCache(
    [path.join(cargoHome, "registry"), path.join(workspace, "target")],
    KEY,
  );
  await fs.promises.rm(path.join(cargoHome, "registry"), { recursive: true });
  await fs.promises.rm(path.join(workspace, "target"), { recursive: true });

  // A machine with no GITHUB_WORKSPACE and no HOME: the workspace archive cannot be placed.
  const partial = createLocalCache(cacheDir, { CARGO_HOME: cargoHome, HOME: cargoHome });
  let restored: string | undefined = KEY;
  const warned = await warnings(async () => {
    restored = await partial.restoreCache([path.join(cargoHome, "registry")], KEY);
  });

  assert.equal(restored, undefined, "one of two archives restored is a miss, not a hit");
  assert.equal(warned.length, 1, `expected one warning, got ${JSON.stringify(warned)}`);
  assert.match(warned[0]!, /restored 1 of 2 archive\(s\)/);
  assert.match(warned[0]!, /workspace/, "the warning must name why the rest did not restore");
  // What did restore stays on disk: the caller re-saves over it after being told this was a miss.
  assert.equal(fs.existsSync(path.join(cargoHome, "registry", "a.txt")), true);
});

/**
 * A truncated or otherwise corrupt archive must degrade like an unplaceable one: recorded and
 * reported as a miss, not thrown. Throwing would abort the loop mid-entry and reach `restore.ts`
 * as "nothing was saved" rather than as the incomplete restore it is.
 */
test("a corrupt archive makes the restore a miss instead of aborting it", async (t) => {
  const { cargoHome, workspace, cacheDir, env } = await sandbox(t);
  await writeTree(path.join(cargoHome, "registry"), { "a.txt": "a" });
  await writeTree(path.join(workspace, "target"), { "b.txt": "b" });
  await createLocalCache(cacheDir, env).saveCache(
    [path.join(cargoHome, "registry"), path.join(workspace, "target")],
    KEY,
  );
  await fs.promises.rm(path.join(cargoHome, "registry"), { recursive: true });
  await fs.promises.rm(path.join(workspace, "target"), { recursive: true });

  // Simulate an out-of-band disk-full or bit-rot: one archive is truncated to a few garbage bytes.
  await fs.promises.writeFile(path.join(cacheDir, KEY, "workspace.tar.zst"), Buffer.from([0, 1, 2, 3]));

  const cache = createLocalCache(cacheDir, env);
  let restored: string | undefined = KEY;
  const warned = await warnings(async () => {
    restored = await cache.restoreCache(
      [path.join(cargoHome, "registry"), path.join(workspace, "target")],
      KEY,
    );
  });

  assert.equal(restored, undefined, "half an entry is a miss, so the good copy can be rebuilt");
  assert.ok(
    warned.some((w) => /workspace\.tar\.zst/.test(w) && /failed to extract/.test(w)),
    `expected a warning naming the corrupt archive, got ${JSON.stringify(warned)}`,
  );
  assert.equal(await fs.promises.readFile(path.join(cargoHome, "registry", "a.txt"), "utf8"), "a");
  assert.equal(fs.existsSync(path.join(workspace, "target", "b.txt")), false);
});

test("an entry that could deliver nothing at all is a miss, not a hit", async (t) => {
  const { workspace, cacheDir } = await sandbox(t);
  await writeTree(path.join(workspace, "target"), { "b.txt": "b" });
  await createLocalCache(cacheDir, { GITHUB_WORKSPACE: workspace }).saveCache(
    [path.join(workspace, "target")],
    KEY,
  );

  // No GITHUB_WORKSPACE here: every archive in the entry is unplaceable.
  const stranded = createLocalCache(cacheDir, {});
  let restored: string | undefined = KEY;
  const warned = await warnings(async () => {
    restored = await stranded.restoreCache([path.join(workspace, "target")], KEY, RESTORE_KEYS);
  });

  // A hit that delivered nothing stops a layered stack from consulting the next layer and
  // stops `restore.ts` from re-saving, leaving the useless entry in place forever.
  assert.equal(restored, undefined);
  assert.ok(
    warned.some((w) => /restored 0 of 1 archive\(s\)/.test(w)),
    `expected a warning that nothing was restored, got ${JSON.stringify(warned)}`,
  );
});

test("restoring an absent key is a miss", async (t) => {
  const { cargoHome, cache } = await sandbox(t);
  await writeTree(path.join(cargoHome, "registry"), { "a.txt": "a" });
  await cache.saveCache([path.join(cargoHome, "registry")], "v1-other-999");

  assert.equal(await cache.restoreCache([cargoHome], KEY), undefined);
  assert.equal(await cache.restoreCache([cargoHome], KEY, RESTORE_KEYS), undefined);
});

test("restoring against an uncreated cache directory is a miss, not an error", async (t) => {
  const { cargoHome, cache } = await sandbox(t);

  assert.equal(await cache.restoreCache([cargoHome], KEY, RESTORE_KEYS), undefined);
});

test("a restore key matches by prefix, most recently written first", async (t) => {
  const { cargoHome, cacheDir, cache } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");

  for (const [index, key] of ["v1-rust-111", "v1-rust-222", "v1-rust-333"].entries()) {
    await writeTree(tree, { "a.txt": key });
    await cache.saveCache([tree], key);
    // Written in one burst, so pin the ordering rather than trusting the clock's resolution.
    const stamp = new Date(Date.now() - (10 - index) * 60_000);
    await fs.promises.utimes(path.join(cacheDir, key), stamp, stamp);
  }
  await writeTree(tree, { "a.txt": "stale" });

  assert.equal(await cache.restoreCache([tree], KEY, RESTORE_KEYS), "v1-rust-333");
  assert.equal(await fs.promises.readFile(path.join(tree, "a.txt"), "utf8"), "v1-rust-333");
});

test("a half-written temp entry is never matched by a prefix search", async (t) => {
  const { cargoHome, cacheDir, cache } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");
  await writeTree(tree, { "a.txt": "real" });
  await cache.saveCache([tree], "v1-rust-111");

  // A saver killed mid-write leaves a dot-prefixed directory behind, newer than the real entry.
  await fs.promises.mkdir(path.join(cacheDir, ".v1-rust-999.abcdef.tmp"), { recursive: true });

  // ".v1-rust-" is a restore key that matches the temp directory's own name, not the real entry's.
  // Without the dot guard, this newer-but-empty directory would be selected first and the restore
  // would come back empty; with the guard it is skipped and the search falls through to the next
  // restore key, landing on the real entry.
  assert.equal(await cache.restoreCache([tree], KEY, [".v1-rust-", "v1-rust-"]), "v1-rust-111");
});

test("the exact key wins over a newer prefix match", async (t) => {
  const { cargoHome, cache } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");

  await writeTree(tree, { "a.txt": "exact" });
  await cache.saveCache([tree], KEY);
  await writeTree(tree, { "a.txt": "prefix" });
  await cache.saveCache([tree], "v1-rust-zzzzzz");

  assert.equal(await cache.restoreCache([tree], KEY, RESTORE_KEYS), KEY);
  assert.equal(await fs.promises.readFile(path.join(tree, "a.txt"), "utf8"), "exact");
});

test("restore keys are tried in order", async (t) => {
  const { cargoHome, cache } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");
  await writeTree(tree, { "a.txt": "a" });
  await cache.saveCache([tree], "v1-first-1");
  await cache.saveCache([tree], "v1-second-1");

  assert.equal(await cache.restoreCache([tree], KEY, ["v1-second-", "v1-first-"]), "v1-second-1");
  assert.equal(await cache.restoreCache([tree], KEY, ["v1-missing-", "v1-first-"]), "v1-first-1");
});

test("lookupOnly reports the match without extracting", async (t) => {
  const { cargoHome, cache } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");
  await writeTree(tree, { "a.txt": "cached" });
  await cache.saveCache([tree], KEY);
  await fs.promises.rm(tree, { recursive: true });

  assert.equal(await cache.restoreCache([tree], KEY, RESTORE_KEYS, { lookupOnly: true }), KEY);
  assert.equal(fs.existsSync(tree), false, "nothing may be extracted for a lookup-only restore");
});

for (const key of ["../escape", "nested/key", "sub\\key", "a..b", ""]) {
  test(`the key ${JSON.stringify(key)} is rejected rather than escaping the cache directory`, async (t) => {
    const { cargoHome, cache } = await sandbox(t);
    await writeTree(path.join(cargoHome, "registry"), { "a.txt": "a" });

    await assert.rejects(
      () => cache.saveCache([path.join(cargoHome, "registry")], key),
      /local cache file name/,
    );
    await assert.rejects(() => cache.restoreCache([cargoHome], key), /local cache file name/);
  });
}

test("saving paths that do not exist fails loudly", async (t) => {
  const { cargoHome, cache } = await sandbox(t);

  await assert.rejects(() => cache.saveCache([path.join(cargoHome, "nope")], KEY), /None of the paths to cache/);
});

test("isFeatureAvailable creates the cache directory and reports it usable", async (t) => {
  const { cacheDir, cache } = await sandbox(t);

  assert.equal(cache.isFeatureAvailable(), true);
  assert.equal(fs.existsSync(cacheDir), true);
});

test("isFeatureAvailable is false without a configured path, and for an unusable one", async (t) => {
  const { root } = await sandbox(t);
  assert.equal(createLocalCache("").isFeatureAvailable(), false);
  assert.equal(createLocalCache("   ").isFeatureAvailable(), false);

  // A regular file where a directory is needed: unusable regardless of the running user.
  const blocked = path.join(root, "blocked");
  await fs.promises.writeFile(blocked, "not a directory");

  assert.equal(createLocalCache(path.join(blocked, "cache")).isFeatureAvailable(), false);
});

/**
 * A writable directory is not enough: without `tar` or `zstd` every call throws. Reporting
 * "available" there costs two confusing errors instead of one clean skip, because `restore.ts`
 * swallows the restore throw without calling `saveState()` and `save.ts` then fails with
 * "Cache configuration not found in state".
 */
test("isFeatureAvailable is false when the tar tooling is missing, naming what is missing", async (t) => {
  const { cacheDir, env } = await sandbox(t);
  const broken = createLocalCache(cacheDir, env, () => {
    throw new Error("The local cache needs `zstd` on PATH, but it was not found.");
  });

  let available = true;
  const warned = await warnings(async () => {
    available = broken.isFeatureAvailable();
  });

  assert.equal(available, false);
  assert.equal(warned.length, 1, `expected one warning, got ${JSON.stringify(warned)}`);
  assert.match(warned[0]!, /zstd/);
});

test("an empty cache directory is rejected instead of resolving against the cwd", async (t) => {
  const { cargoHome, env } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");
  await writeTree(tree, { "a.txt": "a" });
  const cache = createLocalCache("  ", env);

  assert.equal(cache.isFeatureAvailable(), false);
  await assert.rejects(() => cache.saveCache([tree], KEY), /`cache-local-path` is empty/);
  await assert.rejects(() => cache.restoreCache([tree], KEY, RESTORE_KEYS), /`cache-local-path` is empty/);
  assert.equal(fs.existsSync(path.join(process.cwd(), KEY)), false, "nothing may land in the cwd");
});

test("a relative cache directory is resolved once, at construction", async (t) => {
  const { root, cargoHome, env } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");
  await writeTree(tree, { "a.txt": "a" });

  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(cwd));
  const cache = createLocalCache("relative-cache", env);

  await cache.saveCache([tree], KEY);
  process.chdir(cwd); // The entry must not follow the cwd around.
  assert.equal(fs.existsSync(path.join(root, "relative-cache", KEY, "cargo.tar.zst")), true);
  assert.equal(await cache.restoreCache([tree], KEY, RESTORE_KEYS), KEY);
});

test("saveCache leaves no temp directories behind", async (t) => {
  const { cargoHome, cacheDir, cache } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");
  await writeTree(tree, { "a.txt": "a" });
  await cache.saveCache([tree], KEY);

  assert.deepEqual(await fs.promises.readdir(cacheDir), [KEY]);
});

/** First writer wins: a second save of an existing key must leave the first entry untouched. */
test("a second save of an existing key leaves the first entry intact and logs", async (t) => {
  const { cargoHome, cacheDir, cache } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");

  await writeTree(tree, { "a.txt": "first" });
  await cache.saveCache([tree], KEY);
  await writeTree(tree, { "a.txt": "second" });
  const warned = await warnings(async () => {
    await cache.saveCache([tree], KEY);
  });

  await fs.promises.rm(tree, { recursive: true });
  assert.equal(await cache.restoreCache([tree], KEY), KEY);
  assert.equal(await fs.promises.readFile(path.join(tree, "a.txt"), "utf8"), "first");
  assert.deepEqual(await fs.promises.readdir(cacheDir), [KEY], "no temp directory may survive");
  assert.equal(warned.length, 1, `expected one warning that the entry was kept, got ${JSON.stringify(warned)}`);
  assert.match(warned[0]!, /keeping the existing entry/);
});

/**
 * Concurrent savers must never expose a partial entry: each builds a temp directory and
 * renames it into place, and a directory rename is atomic where writing in place is not.
 */
test("concurrent saves of one key never expose a partial entry", async (t) => {
  const { cargoHome, cacheDir, cache } = await sandbox(t);
  const tree = path.join(cargoHome, "registry");
  await fs.promises.mkdir(tree, { recursive: true });
  // Incompressible, so the archive is big enough for a non-atomic write to be caught mid-flight.
  for (let i = 0; i < 4; i++) {
    await fs.promises.writeFile(path.join(tree, `blob-${i}.bin`), randomBytes(2 << 20));
  }

  const archive = path.join(cacheDir, KEY, "cargo.tar.zst");
  let racing = true;
  const observed = new Map<string, number>();
  const reader = (async () => {
    while (racing) {
      try {
        const bytes = await fs.promises.readFile(archive);
        observed.set(createHash("sha256").update(bytes).digest("hex"), bytes.length);
      } catch {
        // The entry not existing yet is expected; this test is about tearing, not absence.
      }
    }
  })();

  await Promise.all([
    cache.saveCache([tree], KEY),
    cache.saveCache([tree], KEY),
    cache.saveCache([tree], KEY),
    cache.saveCache([tree], KEY),
  ]);
  racing = false;
  await reader;

  assert.ok(observed.size > 0, "the reader never managed to read the archive");
  // First writer wins, so every readable state is the one complete archive.
  const final = await fs.promises.readFile(archive);
  const finalDigest = createHash("sha256").update(final).digest("hex");
  assert.deepEqual(
    [...observed.keys()],
    [finalDigest],
    `saw ${observed.size} distinct archive states: ${JSON.stringify([...observed])}`,
  );
});

test("a single provider is usable through the GhCache contract alone", async (t) => {
  const { cargoHome, cache } = await sandbox(t);
  const contract: GhCache = cache;
  const tree = path.join(cargoHome, "registry");
  await writeTree(tree, { "a.txt": "a" });

  assert.equal(contract.isFeatureAvailable(), true);
  await contract.saveCache([tree], KEY);
  assert.equal(await contract.restoreCache([tree], KEY, RESTORE_KEYS), KEY);
});
