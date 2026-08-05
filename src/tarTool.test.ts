import assert from "node:assert/strict";
import { test } from "node:test";

import { detectTarTool, TarProbe } from "./tarTool.js";

/** A probe where `present` names the tools and files that exist; everything else is absent. */
function probe(platform: NodeJS.Platform, present: string[], env: NodeJS.ProcessEnv = {}): TarProbe {
  return {
    platform,
    env,
    which(tool) {
      return present.includes(tool) ? `/usr/bin/${tool}` : undefined;
    },
    exists(file) {
      return present.includes(file);
    },
  };
}

const WIN_TAR = "C:\\Program Files\\Git\\usr\\bin\\tar.exe";
const WIN_ENV = { ProgramFiles: "C:\\Program Files" };

test("Linux uses GNU tar with a single-word compression program", () => {
  const tool = detectTarTool(probe("linux", ["tar", "zstdmt", "unzstd"]));

  assert.equal(tool.tarPath, "/usr/bin/tar");
  assert.deepEqual(tool.compressArgs, ["--use-compress-program", "zstdmt"]);
  assert.deepEqual(tool.decompressArgs, ["--use-compress-program", "unzstd"]);
  assert.deepEqual(tool.createArgs, []);
  assert.deepEqual(tool.extractArgs, []);
});

test("the compression program is always two argv entries and never word-splits", () => {
  const tool = detectTarTool(probe("linux", ["tar", "zstd"]));

  for (const args of [tool.compressArgs, tool.decompressArgs]) {
    assert.equal(args.length, 2);
    assert.equal(args[0], "--use-compress-program");
    assert.doesNotMatch(args[1]!, /\s/, "the program name must be a single word with no flags");
  }
});

test("zstdmt and unzstd fall back to plain zstd", () => {
  const tool = detectTarTool(probe("linux", ["tar", "zstd"]));

  assert.deepEqual(tool.compressArgs, ["--use-compress-program", "zstd"]);
  assert.deepEqual(tool.decompressArgs, ["--use-compress-program", "zstd"]);
});

test("macOS prefers gtar and delays directory restore, else falls back to BSD tar", () => {
  const gnu = detectTarTool(probe("darwin", ["gtar", "tar", "zstd"]));
  assert.equal(gnu.tarPath, "/usr/bin/gtar");
  assert.deepEqual(gnu.extractArgs, ["--delay-directory-restore"]);
  assert.deepEqual(gnu.createArgs, []);

  // Stock BSD tar drives `--use-compress-program` like any other: `@actions/cache`'s piped-zstd
  // workaround for BSD tar is guarded on `IS_WINDOWS`, so macOS needs no separate code path.
  const bsd = detectTarTool(probe("darwin", ["tar", "zstd"]));
  assert.equal(bsd.tarPath, "/usr/bin/tar");
  assert.deepEqual(bsd.extractArgs, [], "--delay-directory-restore is GNU-only");
  assert.deepEqual(bsd.compressArgs, ["--use-compress-program", "zstd"]);
});

test("Windows uses Git for Windows' GNU tar with --force-local", () => {
  const tool = detectTarTool(probe("win32", [WIN_TAR, "zstd"], WIN_ENV));

  assert.equal(tool.tarPath, WIN_TAR);
  assert.deepEqual(tool.createArgs, ["--force-local"]);
  assert.deepEqual(tool.extractArgs, ["--force-local"]);
});

test("Windows without GNU tar fails loud, naming what is missing", () => {
  assert.throws(
    () => detectTarTool(probe("win32", ["tar", "zstd"], WIN_ENV)),
    (e: Error) => {
      assert.match(e.message, /GNU tar/);
      assert.match(e.message, /Git for Windows/);
      return true;
    },
  );
});

test("a missing tar fails loud", () => {
  assert.throws(() => detectTarTool(probe("linux", ["zstd"])), /tar/);
});

test("a missing zstd fails loud rather than producing a multi-word program", () => {
  assert.throws(() => detectTarTool(probe("linux", ["tar"])), /zstd/);
});
