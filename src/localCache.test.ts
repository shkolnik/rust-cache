import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, TestContext } from "node:test";
import { promisify } from "node:util";

import { createLocalCache } from "./localCache.js";
import { GhCache } from "./utils.js";

const run = promisify(execFile);

/** A temp root, removed when the test ends, holding a `cache` and a `work` directory. */
async function sandbox(t: TestContext) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "local-cache-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const work = path.join(root, "work");
  const cacheDir = path.join(root, "cache");
  await fs.promises.mkdir(work, { recursive: true });
  return { root, work, cacheDir, cache: createLocalCache(cacheDir) };
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

const KEY = "v1-rust-abcdef";
const RESTORE_KEYS = ["v1-rust-"];

test("a save/restore round trip reproduces the tree", async (t) => {
  const { work, cache } = await sandbox(t);
  const tree = path.join(work, "target");
  await writeTree(tree, {
    "debug/app": "a binary\n",
    "debug/deps/lib.rlib": "x".repeat(5000),
    ".rustc_info.json": '{"a":1}\n',
    "nested/deeply/placed/file.txt": "nested\n",
  });
  const before = await snapshot(tree);

  assert.equal(typeof (await cache.saveCache([tree], KEY)), "number");

  // The archive holds absolute paths, so a clean location means the tree is gone entirely.
  await fs.promises.rm(tree, { recursive: true });
  assert.equal(await cache.restoreCache([tree], KEY), KEY);

  assert.deepEqual(await snapshot(tree), before);
  assert.equal(before.size, 4);
});

test("restoring an absent key is a miss", async (t) => {
  const { work, cache } = await sandbox(t);
  await writeTree(path.join(work, "target"), { "a.txt": "a" });
  await cache.saveCache([path.join(work, "target")], "v1-other-999");

  assert.equal(await cache.restoreCache([work], KEY), undefined);
  assert.equal(await cache.restoreCache([work], KEY, RESTORE_KEYS), undefined);
});

test("restoring against an uncreated cache directory is a miss, not an error", async (t) => {
  const { work, cache } = await sandbox(t);

  assert.equal(await cache.restoreCache([work], KEY, RESTORE_KEYS), undefined);
});

test("a restore key matches by prefix, most recently written first", async (t) => {
  const { work, cache, cacheDir } = await sandbox(t);
  const tree = path.join(work, "target");

  for (const [index, key] of ["v1-rust-111", "v1-rust-222", "v1-rust-333"].entries()) {
    await writeTree(tree, { "a.txt": key });
    await cache.saveCache([tree], key);
    // Written in one burst, so pin the ordering rather than trusting the clock's resolution.
    const stamp = new Date(Date.now() - (10 - index) * 60_000);
    await fs.promises.utimes(path.join(cacheDir, `${key}.tar.zst`), stamp, stamp);
  }
  await writeTree(tree, { "a.txt": "stale" });

  assert.equal(await cache.restoreCache([tree], KEY, RESTORE_KEYS), "v1-rust-333");
  assert.equal(await fs.promises.readFile(path.join(tree, "a.txt"), "utf8"), "v1-rust-333");
});

test("the exact key wins over a newer prefix match", async (t) => {
  const { work, cache } = await sandbox(t);
  const tree = path.join(work, "target");

  await writeTree(tree, { "a.txt": "exact" });
  await cache.saveCache([tree], KEY);
  await writeTree(tree, { "a.txt": "prefix" });
  await cache.saveCache([tree], "v1-rust-zzzzzz");

  assert.equal(await cache.restoreCache([tree], KEY, RESTORE_KEYS), KEY);
  assert.equal(await fs.promises.readFile(path.join(tree, "a.txt"), "utf8"), "exact");
});

test("restore keys are tried in order", async (t) => {
  const { work, cache } = await sandbox(t);
  const tree = path.join(work, "target");
  await writeTree(tree, { "a.txt": "a" });
  await cache.saveCache([tree], "v1-first-1");
  await cache.saveCache([tree], "v1-second-1");

  assert.equal(await cache.restoreCache([tree], KEY, ["v1-second-", "v1-first-"]), "v1-second-1");
  assert.equal(await cache.restoreCache([tree], KEY, ["v1-missing-", "v1-first-"]), "v1-first-1");
});

test("lookupOnly reports the match without extracting", async (t) => {
  const { work, cache } = await sandbox(t);
  const tree = path.join(work, "target");
  await writeTree(tree, { "a.txt": "cached" });
  await cache.saveCache([tree], KEY);
  await fs.promises.rm(tree, { recursive: true });

  assert.equal(await cache.restoreCache([tree], KEY, RESTORE_KEYS, { lookupOnly: true }), KEY);
  assert.equal(fs.existsSync(tree), false, "nothing may be extracted for a lookup-only restore");
});

for (const key of ["../escape", "nested/key", "sub\\key", "a..b", ""]) {
  test(`the key ${JSON.stringify(key)} is rejected rather than escaping the cache directory`, async (t) => {
    const { work, cache } = await sandbox(t);
    await writeTree(path.join(work, "target"), { "a.txt": "a" });

    await assert.rejects(() => cache.saveCache([path.join(work, "target")], key), /local cache file name/);
    await assert.rejects(() => cache.restoreCache([work], key), /local cache file name/);
  });
}

test("saving paths that do not exist fails loudly", async (t) => {
  const { work, cache } = await sandbox(t);

  await assert.rejects(() => cache.saveCache([path.join(work, "nope")], KEY), /None of the paths to cache/);
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
 * Two savers racing on one key must never expose a partial archive: `saveCache` renames a
 * finished temp file into place, and a rename within a directory is atomic where a copy is not.
 */
test("concurrent saves of one key never expose a partial archive", async (t) => {
  const { work, cacheDir, cache } = await sandbox(t);
  const tree = path.join(work, "target");
  await fs.promises.mkdir(tree, { recursive: true });
  // Incompressible, so the archive is big enough for a non-atomic write to be caught mid-flight.
  for (let i = 0; i < 4; i++) {
    await fs.promises.writeFile(path.join(tree, `blob-${i}.bin`), randomBytes(2 << 20));
  }

  const archive = path.join(cacheDir, `${KEY}.tar.zst`);
  await cache.saveCache([tree], KEY);
  const { stdout: expectedMembers } = await run("tar", ["-P", "--use-compress-program=zstd -d", "-tf", archive]);

  let racing = true;
  const observed = new Map<string, Buffer>();
  const reader = (async () => {
    while (racing && observed.size < 8) {
      let bytes: Buffer;
      try {
        bytes = await fs.promises.readFile(archive);
      } catch {
        continue; // The entry vanishing entirely is a different failure; this test is about tearing.
      }
      observed.set(createHash("sha256").update(bytes).digest("hex"), bytes);
    }
  })();

  for (let round = 0; round < 3; round++) {
    await Promise.all([cache.saveCache([tree], KEY), cache.saveCache([tree], KEY), cache.saveCache([tree], KEY)]);
  }
  racing = false;
  await reader;

  assert.ok(observed.size > 0, "the reader never managed to read the archive");
  const scratch = path.join(work, "observed.tar.zst");
  for (const [digest, bytes] of observed) {
    await fs.promises.writeFile(scratch, bytes);
    const members = await run("tar", ["-P", "--use-compress-program=zstd -d", "-tf", scratch]).then(
      ({ stdout }) => stdout,
      (e) => `unreadable archive: ${e}`,
    );
    assert.equal(members, expectedMembers, `archive ${digest.slice(0, 12)} (${bytes.length} bytes) is not intact`);
  }
});

test("saveCache leaves no temp files behind", async (t) => {
  const { work, cacheDir, cache } = await sandbox(t);
  const tree = path.join(work, "target");
  await writeTree(tree, { "a.txt": "a" });
  await cache.saveCache([tree], KEY);

  assert.deepEqual(await fs.promises.readdir(cacheDir), [`${KEY}.tar.zst`]);
});

test("a single provider is usable through the GhCache contract alone", async (t) => {
  const { work, cache } = await sandbox(t);
  const contract: GhCache = cache;
  const tree = path.join(work, "target");
  await writeTree(tree, { "a.txt": "a" });

  assert.equal(contract.isFeatureAvailable(), true);
  await contract.saveCache([tree], KEY);
  assert.equal(await contract.restoreCache([tree], KEY, RESTORE_KEYS), KEY);
});
