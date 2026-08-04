import assert from "node:assert/strict";
import { test } from "node:test";

import { createLayeredCache, LayerStrategy } from "./layeredCache.js";
import { CacheProvider, GhCache } from "./utils.js";

type RestoreArgs = Parameters<GhCache["restoreCache"]>;

/** An in-memory `GhCache`, recording every call made to it. */
class FakeCache implements GhCache {
  entries = new Map<string, string[]>();
  restoreCalls: RestoreArgs[] = [];
  saveCalls: Array<[string[], string]> = [];
  available = true;
  failRestore = false;
  failSave = false;
  failAvailable = false;

  constructor(public name: string) {}

  isFeatureAvailable: GhCache["isFeatureAvailable"] = () => {
    if (this.failAvailable) {
      throw new Error(`${this.name}: availability boom`);
    }
    return this.available;
  };

  restoreCache: GhCache["restoreCache"] = async (paths, primaryKey, restoreKeys, options) => {
    this.restoreCalls.push([paths, primaryKey, restoreKeys, options]);
    if (this.failRestore) {
      throw new Error(`${this.name}: restore boom`);
    }
    if (this.entries.has(primaryKey)) {
      return primaryKey;
    }
    for (const prefix of restoreKeys ?? []) {
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix)) {
          return key;
        }
      }
    }
    return undefined;
  };

  saveCache: GhCache["saveCache"] = async (paths, key) => {
    this.saveCalls.push([paths, key]);
    if (this.failSave) {
      throw new Error(`${this.name}: save boom`);
    }
    this.entries.set(key, paths);
    return this.saveCalls.length;
  };
}

function provider(cache: FakeCache): CacheProvider {
  return { name: cache.name, cache };
}

function layered(caches: FakeCache[], strategy: LayerStrategy = "exact-first"): GhCache {
  return createLayeredCache(caches.map(provider), strategy);
}

const PATHS = ["/target"];
const KEY = "v1-rust-abcdef";
const RESTORE_KEYS = ["v1-rust-"];
const OLDER_KEY = "v1-rust-123456";

/**
 * Mirrors the action's own control flow: `restore.ts` only calls `config.saveState()` when the
 * restored key is not an exact match, and `save.ts` only saves when that state was set.
 */
async function runAction(cache: GhCache): Promise<string | undefined> {
  const restored = await cache.restoreCache(PATHS.slice(), KEY, RESTORE_KEYS, {});
  if (restored !== KEY) {
    await cache.saveCache(PATHS.slice(), KEY);
  }
  return restored;
}

test("exact-first consults layers nearest to farthest and stops at the first hit", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.entries.set(KEY, PATHS);
  far.entries.set(KEY, PATHS);

  const restored = await layered([near, far]).restoreCache(PATHS, KEY, RESTORE_KEYS);

  assert.equal(restored, KEY);
  assert.equal(near.restoreCalls.length, 1);
  assert.equal(far.restoreCalls.length, 0, "farther layer must not be contacted after a nearest hit");
});

test("exact-first does a full exact-only pass before any pass with restore keys", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.entries.set(OLDER_KEY, PATHS);
  far.entries.set(OLDER_KEY, PATHS);

  const restored = await layered([near, far]).restoreCache(PATHS, KEY, RESTORE_KEYS);

  assert.equal(restored, OLDER_KEY);
  assert.deepEqual(
    [near.restoreCalls[0]![2], far.restoreCalls[0]![2], near.restoreCalls[1]![2]],
    [[], [], RESTORE_KEYS],
    "pass 1 is exact-only across every layer, pass 2 adds the restore keys",
  );
});

test("nearest-first makes a single pass, restore keys included", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  far.entries.set(KEY, PATHS);

  const restored = await layered([near, far], "nearest-first").restoreCache(PATHS, KEY, RESTORE_KEYS);

  assert.equal(restored, KEY);
  assert.equal(near.restoreCalls.length, 1);
  assert.deepEqual(near.restoreCalls[0]![2], RESTORE_KEYS);
  assert.deepEqual(far.restoreCalls[0]![2], RESTORE_KEYS);
});

test("the strategies differ when a nearer layer has a prefix match and a farther layer the exact key", async () => {
  const exactFirst = [new FakeCache("near"), new FakeCache("far")];
  exactFirst[0]!.entries.set(OLDER_KEY, PATHS);
  exactFirst[1]!.entries.set(KEY, PATHS);
  assert.equal(await layered(exactFirst, "exact-first").restoreCache(PATHS, KEY, RESTORE_KEYS), KEY);

  const nearestFirst = [new FakeCache("near"), new FakeCache("far")];
  nearestFirst[0]!.entries.set(OLDER_KEY, PATHS);
  nearestFirst[1]!.entries.set(KEY, PATHS);
  assert.equal(await layered(nearestFirst, "nearest-first").restoreCache(PATHS, KEY, RESTORE_KEYS), OLDER_KEY);
  assert.equal(nearestFirst[1]!.restoreCalls.length, 0, "nearest-first is served by the nearer layer alone");
});

test("restoreCache writes a farther layer's hit back to every nearer layer", async () => {
  const [near, mid, far] = [new FakeCache("near"), new FakeCache("mid"), new FakeCache("far")];
  far.entries.set(KEY, PATHS);

  const restored = await layered([near, mid, far]).restoreCache(PATHS, KEY, RESTORE_KEYS);

  assert.equal(restored, KEY);
  assert.deepEqual(near.saveCalls, [[PATHS, KEY]]);
  assert.deepEqual(mid.saveCalls, [[PATHS, KEY]]);
  assert.deepEqual(far.saveCalls, [], "the layer that served the hit is not rewritten");
  assert.equal(near.entries.has(KEY), true, "the nearer layer now holds the key");
});

test("write-back uses the key that was actually restored, not the requested one", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  far.entries.set(OLDER_KEY, PATHS);

  const restored = await layered([near, far]).restoreCache(PATHS, KEY, RESTORE_KEYS);

  assert.equal(restored, OLDER_KEY);
  assert.deepEqual(near.saveCalls, [[PATHS, OLDER_KEY]]);
});

test("write-back is suppressed for a lookup-only restore", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  far.entries.set(KEY, PATHS);

  const restored = await layered([near, far]).restoreCache(PATHS, KEY, RESTORE_KEYS, { lookupOnly: true });

  assert.equal(restored, KEY);
  assert.deepEqual(near.saveCalls, [], "nothing was downloaded, so there is nothing to write back");
});

test("write-back failure does not fail the restore", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.failSave = true;
  far.entries.set(KEY, PATHS);

  assert.equal(await layered([near, far]).restoreCache(PATHS, KEY, RESTORE_KEYS), KEY);
});

test("restoreCache forwards its options to every layer", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  const options = { lookupOnly: false, useAzureSdk: true };

  await layered([near, far], "nearest-first").restoreCache(PATHS, KEY, RESTORE_KEYS, options);

  assert.equal(near.restoreCalls[0]![3], options);
  assert.equal(far.restoreCalls[0]![3], options);
});

test("a layer whose restoreCache throws degrades to the next layer", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.failRestore = true;
  far.entries.set(KEY, PATHS);

  assert.equal(await layered([near, far]).restoreCache(PATHS, KEY, RESTORE_KEYS), KEY);
});

test("restoreCache resolves undefined when every layer throws", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.failRestore = true;
  far.failRestore = true;

  assert.equal(await layered([near, far]).restoreCache(PATHS, KEY, RESTORE_KEYS), undefined);
});

test("saveCache writes to every layer and returns the first success", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];

  const result = await layered([near, far]).saveCache(PATHS, KEY);

  assert.equal(result, 1);
  assert.deepEqual(near.saveCalls, [[PATHS, KEY]]);
  assert.deepEqual(far.saveCalls, [[PATHS, KEY]]);
});

test("a layer whose saveCache throws does not stop the other layers", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.failSave = true;

  assert.equal(await layered([near, far]).saveCache(PATHS, KEY), 1);
  assert.equal(far.entries.has(KEY), true);
});

test("saveCache resolves -1 when every layer fails", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.failSave = true;
  far.failSave = true;

  assert.equal(await layered([near, far]).saveCache(PATHS, KEY), -1);
});

test("isFeatureAvailable is true if any layer is available", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.available = false;

  assert.equal(layered([near, far]).isFeatureAvailable(), true);
});

test("isFeatureAvailable is false when no layer is available", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.available = false;
  far.available = false;

  assert.equal(layered([near, far]).isFeatureAvailable(), false);
});

test("a layer whose isFeatureAvailable throws counts as unavailable", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.failAvailable = true;
  far.available = false;

  assert.equal(layered([near, far]).isFeatureAvailable(), false);
  far.available = true;
  assert.equal(layered([near, far]).isFeatureAvailable(), true);
});

for (const strategy of ["exact-first", "nearest-first"] as const) {
  test(`a single layer is called exactly once, with the restore keys (${strategy})`, async () => {
    const only = new FakeCache("only");
    const options = { lookupOnly: false };

    await layered([only], strategy).restoreCache(PATHS, KEY, RESTORE_KEYS, options);

    assert.equal(only.restoreCalls.length, 1);
    assert.deepEqual(only.restoreCalls[0], [PATHS, KEY, RESTORE_KEYS, options]);
  });
}

// The four rows of the write matrix, each driven through the action's own restore/save sequence.

test("write matrix: exact hit in the nearest layer writes nothing", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  near.entries.set(KEY, PATHS);
  far.entries.set(KEY, PATHS);

  assert.equal(await runAction(layered([near, far])), KEY);
  assert.deepEqual(near.saveCalls, []);
  assert.deepEqual(far.saveCalls, []);
});

test("write matrix: nearest miss then a farther exact hit writes back to the nearer layer only", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  far.entries.set(KEY, PATHS);

  assert.equal(await runAction(layered([near, far])), KEY);
  assert.deepEqual(near.saveCalls.map(([, key]) => key), [KEY]);
  assert.deepEqual(far.saveCalls, [], "the farther layer already holds the key");
});

test("write matrix: nearest miss then a farther partial hit writes both layers", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];
  far.entries.set(OLDER_KEY, PATHS);

  assert.equal(await runAction(layered([near, far])), OLDER_KEY);
  assert.deepEqual(near.saveCalls.map(([, key]) => key), [OLDER_KEY, KEY], "write-back, then the save");
  assert.deepEqual(far.saveCalls.map(([, key]) => key), [KEY]);
});

test("write matrix: a miss at every layer writes both layers", async () => {
  const [near, far] = [new FakeCache("near"), new FakeCache("far")];

  assert.equal(await runAction(layered([near, far])), undefined);
  assert.deepEqual(near.saveCalls.map(([, key]) => key), [KEY]);
  assert.deepEqual(far.saveCalls.map(([, key]) => key), [KEY]);
});
