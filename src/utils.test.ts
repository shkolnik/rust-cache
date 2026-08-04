import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exists, getCacheProvider } from "./utils.js";

const thisFile = fileURLToPath(import.meta.url);

test("exists returns true for a path that exists", async () => {
  assert.equal(await exists(thisFile), true);
});

test("exists returns false for a path that does not exist", async () => {
  assert.equal(await exists(`${thisFile}.does-not-exist`), false);
});

/** Runs `fn` with the given action inputs, and only those, in the environment. */
async function withInputs<T>(inputs: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const names = ["cache-provider", "cache-local-path", "cache-layer-strategy"];
  const saved = new Map(names.map((name) => [name, process.env[`INPUT_${name.toUpperCase()}`]]));
  try {
    for (const name of names) {
      const value = inputs[name];
      if (value === undefined) {
        delete process.env[`INPUT_${name.toUpperCase()}`];
      } else {
        process.env[`INPUT_${name.toUpperCase()}`] = value;
      }
    }
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[`INPUT_${name.toUpperCase()}`];
      } else {
        process.env[`INPUT_${name.toUpperCase()}`] = value;
      }
    }
  }
}

test("a single `cache-provider` is the module itself, not a layered wrapper", async () => {
  const ghCache = await import("@actions/cache");
  const provider = await withInputs({ "cache-provider": "github" }, getCacheProvider);

  assert.equal(provider.name, "github");
  assert.equal(provider.cache, ghCache);
});

test("a single `cache-provider` is unwrapped even with a non-default strategy", async () => {
  const ghCache = await import("@actions/cache");
  const provider = await withInputs(
    { "cache-provider": "github", "cache-layer-strategy": "nearest-first" },
    getCacheProvider,
  );

  assert.equal(provider.cache, ghCache);
});

test("`warpbuild` keeps resolving to its own module", async () => {
  const warpCache = await import("@actions/warpbuild-cache");
  const provider = await withInputs({ "cache-provider": "warpbuild" }, getCacheProvider);

  assert.equal(provider.name, "warpbuild");
  assert.equal(provider.cache, warpCache);
});

test("`local` resolves to a local cache, unwrapped", async () => {
  const provider = await withInputs(
    { "cache-provider": "local", "cache-local-path": "/tmp/rust-cache-test" },
    getCacheProvider,
  );

  assert.equal(provider.name, "local");
  assert.equal(typeof provider.cache.restoreCache, "function");
});

test("several providers are layered, in the order written, and whitespace is trimmed", async () => {
  const ghCache = await import("@actions/cache");
  const provider = await withInputs(
    { "cache-provider": " local , github ", "cache-local-path": "/tmp/rust-cache-test" },
    getCacheProvider,
  );

  assert.equal(provider.name, "local,github");
  assert.notEqual(provider.cache, ghCache);
});

test("an unknown provider throws the plain invalid-provider error", async () => {
  await assert.rejects(() => withInputs({ "cache-provider": "nope" }, getCacheProvider), {
    message: "The `cache-provider` `nope` is not valid.",
  });
});

test("an unknown provider in a stack throws the plain invalid-provider error", async () => {
  await assert.rejects(() => withInputs({ "cache-provider": "github,nope" }, getCacheProvider), {
    message: "The `cache-provider` `nope` is not valid.",
  });
});

for (const input of ["", ",", "github,,local", " , "]) {
  test(`an empty entry in \`cache-provider\` \`${input}\` throws`, async () => {
    await assert.rejects(() => withInputs({ "cache-provider": input }, getCacheProvider), {
      message: `The \`cache-provider\` \`${input.trim()}\` is not valid: it has an empty entry.`,
    });
  });
}

test("`local` without a `cache-local-path` throws", async () => {
  await assert.rejects(() => withInputs({ "cache-provider": "local,github" }, getCacheProvider), {
    message: "The `local` `cache-provider` requires a `cache-local-path`.",
  });
});

test("an invalid `cache-layer-strategy` throws", async () => {
  await assert.rejects(
    () => withInputs({ "cache-provider": "github", "cache-layer-strategy": "nearest" }, getCacheProvider),
    { message: "The `cache-layer-strategy` `nearest` is not valid. Use `exact-first` or `nearest-first`." },
  );
});
