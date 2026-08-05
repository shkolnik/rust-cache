# Portable `LocalCache` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `LocalCache` entries relocatable and portable across Linux, macOS and Windows by replacing absolute-path (`tar -P`) archives with per-root archives whose member names are relative to a named root.

**Architecture:** An entry becomes a *directory* `<cacheDir>/<key>/` holding one archive per root (`cargo.tar.zst`, `workspace.tar.zst`, `abs-<pct>.tar.zst`). Each archive is created with `tar -C <root>` and plain relative members, and extracted with `-C <that root's value on the restoring machine>`. Relocation falls out of the two `-C` values differing — no manifest, no absolute member names. Two new modules carry the new responsibilities: `src/cacheRoots.ts` (pure path↔token functions) and `src/tarTool.ts` (a platform tar/zstd probe). `src/localCache.ts` is rewritten to compose them.

**Tech Stack:** TypeScript, Node 24, `node:test` + `node:assert/strict`, `@actions/core`, `@actions/exec`, `@actions/io`, rollup.

## Global Constraints

Copied verbatim in substance from `docs/superpowers/specs/2026-08-04-portable-local-cache-design.md`. Every task's requirements implicitly include this section.

- **Branch:** all work happens on `feat/portable-local-cache`, currently at `4f4ee08`, stacked on `cd26941`. Never commit to `master`.
- **Do not touch:** `src/config.ts`, `src/cleanup.ts`, `src/workspace.ts`, `src/restore.ts`, `src/save.ts`, `action.yml`, `src/utils.ts`, `src/layeredCache.ts`. If a change appears to require editing any of them, stop and report — the responsibility landed in the wrong place.
- **`createLocalCache`'s existing call signature stays source-compatible.** `createLocalCache(cacheDir)` must keep working unchanged, because `src/utils.ts` calls it that way and `src/utils.ts` is out of scope. New parameters must be optional and trailing.
- **No new runtime dependencies.** Tests use `node:test` and `node:assert/strict` only.
- **Compression flags are two argv entries, never one word-split token:** `["--use-compress-program", "<program>"]`. The program name must be a single word with no embedded flags.
- **Windows without GNU tar is unsupported and must fail loud**, naming what is missing. It must never silently degrade.
- **Atomicity is first-writer-wins:** build a temp directory, `rename()` it into place; if the destination exists, remove the temp and log. Rename only ever *creates*.
- **Key validation is retained unchanged:** a key that is blank or contains `/`, `\`, or `..` is rejected with an error matching `/local cache file name/`.
- **A restore that delivers nothing is a miss (`undefined`), not a hit.** A hit that delivered nothing stops a layered stack from consulting the next layer and stops the action from re-saving.
- **Errors that degrade must still be logged** via `core.warning`.
- **Run the full suite with `npm test`** (which runs `tsc` first). Never weaken or delete an assertion to get a green run.
- **`dist/` is rebuilt and committed only in the final task.** Anything committed after it re-stales the bundle.

---

### Task 1: Root table and path encoding

Pure functions mapping absolute paths to `(token, root dir, relative member)` and back. No filesystem access, no `process.env` reads inside the functions — the environment is a parameter, so every platform's behaviour is testable on Linux.

**Files:**
- Create: `src/cacheRoots.ts`
- Test: `src/cacheRoots.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all exported from `src/cacheRoots.ts`:
  - `interface CacheRoot { token: string; dir: string }`
  - `interface RootAssignment { token: string; dir: string; member: string }`
  - `function rootTable(env: NodeJS.ProcessEnv, p?: path.PlatformPath): CacheRoot[]`
  - `function encodePathToken(abs: string): string`
  - `function decodePathToken(token: string): string`
  - `function assignRoot(target: string, roots: CacheRoot[], p?: path.PlatformPath): RootAssignment`
  - `function groupByRoot(targets: string[], roots: CacheRoot[], p?: path.PlatformPath): Map<string, { dir: string; members: string[] }>`
  - `function resolveToken(token: string, roots: CacheRoot[], p?: path.PlatformPath): string | undefined`

  In every signature `p` defaults to `path` (the platform-native binding). Tests pass `path.win32` or `path.posix` explicitly.

- [ ] **Step 1: Write the failing tests**

Create `src/cacheRoots.test.ts`:

```ts
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  assignRoot,
  CacheRoot,
  decodePathToken,
  encodePathToken,
  groupByRoot,
  resolveToken,
  rootTable,
} from "./cacheRoots.js";

const POSIX_ENV = {
  CARGO_HOME: "/home/runner/.cargo",
  GITHUB_WORKSPACE: "/home/runner/work/proj/proj",
  HOME: "/home/runner",
};

test("the root table is built from the environment, longest first", () => {
  const roots = rootTable(POSIX_ENV, path.posix);

  // Longest-first ordering is load-bearing: `assignRoot` takes the first match.
  assert.deepEqual(roots, [
    { token: "workspace", dir: "/home/runner/work/proj/proj" },
    { token: "cargo", dir: "/home/runner/.cargo" },
    { token: "home", dir: "/home/runner" },
  ]);
});

test("CARGO_HOME falls back to $HOME/.cargo, and unset roots are omitted", () => {
  assert.deepEqual(rootTable({ HOME: "/home/runner" }, path.posix), [
    { token: "cargo", dir: "/home/runner/.cargo" },
    { token: "home", dir: "/home/runner" },
  ]);
  assert.deepEqual(rootTable({}, path.posix), []);
  assert.deepEqual(rootTable({ CARGO_HOME: "   " }, path.posix), []);
});

test("the longest matching root wins", () => {
  const roots = rootTable(POSIX_ENV, path.posix);

  // Under $HOME, but a longer root matches.
  assert.deepEqual(assignRoot("/home/runner/.cargo/registry", roots, path.posix), {
    token: "cargo",
    dir: "/home/runner/.cargo",
    member: "registry",
  });
  assert.deepEqual(assignRoot("/home/runner/work/proj/proj/target", roots, path.posix), {
    token: "workspace",
    dir: "/home/runner/work/proj/proj",
    member: "target",
  });
  assert.deepEqual(assignRoot("/home/runner/other", roots, path.posix), {
    token: "home",
    dir: "/home/runner",
    member: "other",
  });
});

test("a path that is a root exactly yields a member of '.'", () => {
  const roots = rootTable(POSIX_ENV, path.posix);

  assert.deepEqual(assignRoot("/home/runner/work/proj/proj", roots, path.posix), {
    token: "workspace",
    dir: "/home/runner/work/proj/proj",
    member: ".",
  });
});

test("a path under no root falls back to an abs- token at its parent", () => {
  const roots = rootTable(POSIX_ENV, path.posix);

  assert.deepEqual(assignRoot("/opt/shared-cache", roots, path.posix), {
    token: "abs-%2Fopt%2Fshared-cache",
    dir: "/opt",
    member: "shared-cache",
  });
});

test("a sibling prefix is not treated as a root match", () => {
  const roots: CacheRoot[] = [{ token: "cargo", dir: "/home/runner/.cargo" }];

  // "/home/runner/.cargo-other" starts with the root string but is not under it.
  const assigned = assignRoot("/home/runner/.cargo-other", roots, path.posix);
  assert.equal(assigned.token, "abs-%2Fhome%2Frunner%2F.cargo-other");
});

test("the encoding is injective, filename-safe, and round trips", () => {
  const cases = [
    "/opt/shared-cache",
    "/home/runner/a b/c+d",
    "C:\\Users\\runneradmin\\cache",
    "/tmp/ünïcode/路径",
    "/a.b_c-d",
  ];
  for (const value of cases) {
    const token = encodePathToken(value);
    assert.equal(decodePathToken(token), value, `round trip failed for ${value}`);
    assert.match(token, /^[A-Za-z0-9._%-]*$/, `${token} is not filename-safe`);
    assert.equal(token.includes("/"), false);
    assert.equal(token.includes("\\"), false);
    assert.equal(token.includes(":"), false);
  }
  assert.equal(new Set(cases.map(encodePathToken)).size, cases.length, "encoding collided");
  assert.equal(encodePathToken("/a.b_c-d"), "%2Fa.b_c-d");
  assert.equal(encodePathToken("C:\\x"), "C%3A%5Cx");
});

test("Windows paths group by root case-insensitively and keep their drive", () => {
  const env = {
    CARGO_HOME: "C:\\Users\\runneradmin\\.cargo",
    GITHUB_WORKSPACE: "D:\\a\\proj\\proj",
  };
  const roots = rootTable(env, path.win32);

  assert.deepEqual(assignRoot("c:\\users\\runneradmin\\.cargo\\registry", roots, path.win32), {
    token: "cargo",
    dir: "C:\\Users\\runneradmin\\.cargo",
    member: "registry",
  });
  // A different drive is under no root.
  assert.equal(assignRoot("E:\\scratch\\thing", roots, path.win32).token, "abs-E%3A%5Cscratch%5Cthing");
});

test("several paths under one root share a single archive", () => {
  const roots = rootTable(POSIX_ENV, path.posix);
  const grouped = groupByRoot(
    [
      "/home/runner/.cargo/registry",
      "/home/runner/.cargo/git",
      "/home/runner/work/proj/proj/target",
      "/opt/shared-cache",
    ],
    roots,
    path.posix,
  );

  assert.deepEqual([...grouped.keys()].sort(), [
    "abs-%2Fopt%2Fshared-cache",
    "cargo",
    "workspace",
  ]);
  assert.deepEqual(grouped.get("cargo"), { dir: "/home/runner/.cargo", members: ["registry", "git"] });
  assert.deepEqual(grouped.get("workspace"), {
    dir: "/home/runner/work/proj/proj",
    members: ["target"],
  });
});

test("duplicate paths collapse to one member", () => {
  const roots = rootTable(POSIX_ENV, path.posix);
  const grouped = groupByRoot(
    ["/home/runner/.cargo/registry", "/home/runner/.cargo/registry"],
    roots,
    path.posix,
  );

  assert.deepEqual(grouped.get("cargo"), { dir: "/home/runner/.cargo", members: ["registry"] });
});

test("a token resolves back to the root it should extract under", () => {
  const roots = rootTable(POSIX_ENV, path.posix);

  assert.equal(resolveToken("cargo", roots, path.posix), "/home/runner/.cargo");
  assert.equal(resolveToken("abs-%2Fopt%2Fshared-cache", roots, path.posix), "/opt");
  assert.equal(resolveToken("workspace", rootTable({ HOME: "/h" }, path.posix), path.posix), undefined);
  assert.equal(resolveToken("nonsense", roots, path.posix), undefined);
});

test("relocation: the same member resolves under a different machine's roots", () => {
  const saver = rootTable({ CARGO_HOME: "/home/runner/.cargo" }, path.posix);
  const restorer = rootTable({ CARGO_HOME: "/mnt/big/cargo" }, path.posix);

  const assigned = assignRoot("/home/runner/.cargo/registry", saver, path.posix);
  assert.equal(assigned.member, "registry");
  assert.equal(resolveToken(assigned.token, restorer, path.posix), "/mnt/big/cargo");
});

test("a filesystem root cannot be cached", () => {
  assert.throws(() => assignRoot("/", [], path.posix), /cannot be cached/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `tsc` errors that `./cacheRoots.js` has no exported members / cannot find module.

- [ ] **Step 3: Write the implementation**

Create `src/cacheRoots.ts`:

```ts
import nodePath from "node:path";

/** A named directory that cached paths are recorded relative to. */
export interface CacheRoot {
  token: string;
  dir: string;
}

/** Where one requested path lives: which archive holds it, and under what name. */
export interface RootAssignment {
  token: string;
  /** The directory the archive is created and extracted with (`tar -C`). */
  dir: string;
  /** The member name inside the archive, relative to `dir`. */
  member: string;
}

const ABS_PREFIX = "abs-";
/** Everything outside this set is percent-encoded, so a token is always a legal file name. */
const UNRESERVED = /^[A-Za-z0-9._-]$/;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The roots this machine offers, longest first so a prefix search can take the first match.
 * The environment is a parameter rather than a read of `process.env` so every platform's
 * behaviour is testable from any platform.
 */
export function rootTable(env: NodeJS.ProcessEnv, p: nodePath.PlatformPath = nodePath): CacheRoot[] {
  const home = clean(env.HOME);
  const candidates: Array<[string, string | undefined]> = [
    ["cargo", clean(env.CARGO_HOME) ?? (home && p.join(home, ".cargo"))],
    ["workspace", clean(env.GITHUB_WORKSPACE)],
    ["home", home],
  ];

  return candidates
    .flatMap(([token, dir]) => (dir ? [{ token, dir: p.resolve(dir) }] : []))
    .sort((a, b) => b.dir.length - a.dir.length);
}

/** Percent-encodes every byte outside `[A-Za-z0-9._-]`, so the result is a legal file name. */
export function encodePathToken(abs: string): string {
  let encoded = "";
  for (const byte of Buffer.from(abs, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** The inverse of {@link encodePathToken}. */
export function decodePathToken(token: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "%") {
      bytes.push(parseInt(token.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(token.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Windows path comparison is case-insensitive; POSIX is not. */
function fold(value: string, p: nodePath.PlatformPath): string {
  return p === nodePath.win32 ? value.toLowerCase() : value;
}

/** Which archive holds `target`, and under what member name. */
export function assignRoot(
  target: string,
  roots: CacheRoot[],
  p: nodePath.PlatformPath = nodePath,
): RootAssignment {
  const abs = p.resolve(target);
  if (p.dirname(abs) === abs) {
    throw new Error(`The path ${abs} is a filesystem root and cannot be cached.`);
  }

  // `roots` is sorted longest-first, so the first match is the longest one.
  for (const root of roots) {
    const folded = fold(abs, p);
    const prefix = fold(root.dir, p);
    if (folded === prefix || folded.startsWith(prefix + p.sep)) {
      return { token: root.token, dir: root.dir, member: p.relative(root.dir, abs) || "." };
    }
  }

  return {
    token: ABS_PREFIX + encodePathToken(abs),
    dir: p.dirname(abs),
    member: p.basename(abs),
  };
}

/** Groups requested paths into one archive per root, preserving order and dropping duplicates. */
export function groupByRoot(
  targets: string[],
  roots: CacheRoot[],
  p: nodePath.PlatformPath = nodePath,
): Map<string, { dir: string; members: string[] }> {
  const grouped = new Map<string, { dir: string; members: string[] }>();
  for (const target of targets) {
    const { token, dir, member } = assignRoot(target, roots, p);
    const group = grouped.get(token) ?? { dir, members: [] };
    if (!group.members.includes(member)) {
      group.members.push(member);
    }
    grouped.set(token, group);
  }
  return grouped;
}

/** The directory an archive named `<token>.tar.zst` must be extracted under, if this machine has it. */
export function resolveToken(
  token: string,
  roots: CacheRoot[],
  p: nodePath.PlatformPath = nodePath,
): string | undefined {
  if (token.startsWith(ABS_PREFIX)) {
    return p.dirname(decodePathToken(token.slice(ABS_PREFIX.length)));
  }
  return roots.find((root) => root.token === token)?.dir;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — every `cacheRoots` test green, and the pre-existing `layeredCache`, `utils` and `localCache` tests still green.

- [ ] **Step 5: Prove the longest-prefix test has teeth**

Temporarily change the `.sort(...)` in `rootTable` to `.sort((a, b) => a.dir.length - b.dir.length)` (shortest first).

Run: `npm test`
Expected: FAIL — "the longest matching root wins" reports `home` where `cargo` was expected.

Revert the sort to longest-first and re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cacheRoots.ts src/cacheRoots.test.ts
git commit -m "feat(local): add a reversible root/path encoding for relocatable entries"
```

---

### Task 2: Platform tar and zstd probe

Selects the tar binary, its flavour, and the single-word compression program, per the spec's §2.5 matrix. Detection is a pure function over injected dependencies so all three platforms are testable on Linux; a thin cached wrapper supplies the real ones.

**Files:**
- Create: `src/tarTool.ts`
- Test: `src/tarTool.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, exported from `src/tarTool.ts`:
  - `interface TarTool { tarPath: string; flavour: "gnu" | "bsd"; createArgs: string[]; extractArgs: string[]; compressArgs: string[]; decompressArgs: string[] }`
  - `interface TarProbe { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; which(tool: string): Promise<string>; exists(file: string): Promise<boolean> }`
  - `function detectTarTool(probe: TarProbe): Promise<TarTool>`
  - `function tarTool(): Promise<TarTool>` — caches the first successful result in a module-level promise.

  `which` resolves to the tool's path or rejects/resolves empty when absent; `detectTarTool` must treat both a rejection and an empty string as "absent".

- [ ] **Step 1: Write the failing tests**

Create `src/tarTool.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectTarTool, TarProbe } from "./tarTool.js";

/** A probe where `present` names the tools and files that exist; everything else is absent. */
function probe(platform: NodeJS.Platform, present: string[], env: NodeJS.ProcessEnv = {}): TarProbe {
  return {
    platform,
    env,
    async which(tool) {
      const hit = present.find((p) => p === tool);
      if (!hit) {
        throw new Error(`Unable to locate executable file: ${tool}`);
      }
      return `/usr/bin/${hit}`;
    },
    async exists(file) {
      return present.includes(file);
    },
  };
}

const WIN_TAR = "C:\\Program Files\\Git\\usr\\bin\\tar.exe";
const WIN_ENV = { ProgramFiles: "C:\\Program Files" };

test("Linux uses GNU tar with a single-word compression program", async () => {
  const tool = await detectTarTool(probe("linux", ["tar", "zstdmt", "unzstd"]));

  assert.equal(tool.flavour, "gnu");
  assert.equal(tool.tarPath, "/usr/bin/tar");
  assert.deepEqual(tool.compressArgs, ["--use-compress-program", "zstdmt"]);
  assert.deepEqual(tool.decompressArgs, ["--use-compress-program", "unzstd"]);
  assert.deepEqual(tool.createArgs, []);
  assert.deepEqual(tool.extractArgs, []);
});

test("the compression program is always two argv entries and never word-splits", async () => {
  const tool = await detectTarTool(probe("linux", ["tar", "zstd"]));

  for (const args of [tool.compressArgs, tool.decompressArgs]) {
    assert.equal(args.length, 2);
    assert.equal(args[0], "--use-compress-program");
    assert.doesNotMatch(args[1]!, /\s/, "the program name must be a single word with no flags");
  }
});

test("zstdmt and unzstd fall back to plain zstd", async () => {
  const tool = await detectTarTool(probe("linux", ["tar", "zstd"]));

  assert.deepEqual(tool.compressArgs, ["--use-compress-program", "zstd"]);
  assert.deepEqual(tool.decompressArgs, ["--use-compress-program", "zstd"]);
});

test("macOS prefers gtar and delays directory restore, else falls back to BSD tar", async () => {
  const gnu = await detectTarTool(probe("darwin", ["gtar", "tar", "zstd"]));
  assert.equal(gnu.flavour, "gnu");
  assert.equal(gnu.tarPath, "/usr/bin/gtar");
  assert.deepEqual(gnu.extractArgs, ["--delay-directory-restore"]);
  assert.deepEqual(gnu.createArgs, []);

  const bsd = await detectTarTool(probe("darwin", ["tar", "zstd"]));
  assert.equal(bsd.flavour, "bsd");
  assert.equal(bsd.tarPath, "/usr/bin/tar");
  assert.deepEqual(bsd.extractArgs, [], "--delay-directory-restore is GNU-only");
});

test("Windows uses Git for Windows' GNU tar with --force-local", async () => {
  const tool = await detectTarTool(probe("win32", [WIN_TAR, "zstd"], WIN_ENV));

  assert.equal(tool.flavour, "gnu");
  assert.equal(tool.tarPath, WIN_TAR);
  assert.deepEqual(tool.createArgs, ["--force-local"]);
  assert.deepEqual(tool.extractArgs, ["--force-local"]);
});

test("Windows without GNU tar fails loud, naming what is missing", async () => {
  await assert.rejects(
    () => detectTarTool(probe("win32", ["tar", "zstd"], WIN_ENV)),
    (e: Error) => {
      assert.match(e.message, /GNU tar/);
      assert.match(e.message, /Git for Windows/);
      return true;
    },
  );
});

test("a missing tar fails loud", async () => {
  await assert.rejects(() => detectTarTool(probe("linux", ["zstd"])), /tar/);
});

test("a missing zstd fails loud rather than producing a multi-word program", async () => {
  await assert.rejects(() => detectTarTool(probe("linux", ["tar"])), /zstd/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `tsc` cannot find `./tarTool.js`.

- [ ] **Step 3: Write the implementation**

Create `src/tarTool.ts`:

```ts
import * as io from "@actions/io";
import fs from "node:fs";
import path from "node:path";

/** The tar invocation this machine supports, resolved once. */
export interface TarTool {
  tarPath: string;
  flavour: "gnu" | "bsd";
  /** Flags valid only when creating. */
  createArgs: string[];
  /** Flags valid only when extracting. */
  extractArgs: string[];
  compressArgs: string[];
  decompressArgs: string[];
}

/** The environment `detectTarTool` inspects, injected so every platform is testable from any one. */
export interface TarProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  which(tool: string): Promise<string>;
  exists(file: string): Promise<boolean>;
}

async function find(probe: TarProbe, tool: string): Promise<string | undefined> {
  try {
    return (await probe.which(tool)) || undefined;
  } catch {
    return undefined;
  }
}

/** The first of `names` this machine has. Single words only: tar word-splits nothing for us. */
async function firstProgram(probe: TarProbe, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    if (await find(probe, name)) {
      return name;
    }
  }
  return undefined;
}

export async function detectTarTool(probe: TarProbe): Promise<TarTool> {
  let tarPath: string | undefined;
  let flavour: "gnu" | "bsd" = "gnu";
  const createArgs: string[] = [];
  const extractArgs: string[] = [];

  if (probe.platform === "win32") {
    // Windows ships BSD tar, which cannot drive `--use-compress-program`. Git for Windows'
    // GNU tar is the only supported option, and its absence is an error rather than a degrade.
    const gnuTar = path.join(probe.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "usr", "bin", "tar.exe");
    if (!(await probe.exists(gnuTar))) {
      throw new Error(
        `The local cache needs GNU tar on Windows, but ${gnuTar} does not exist.` +
          ` Install Git for Windows, which provides it.`,
      );
    }
    tarPath = gnuTar;
    // Without this, GNU tar reads the `C:` in a path as a remote host name.
    createArgs.push("--force-local");
    extractArgs.push("--force-local");
  } else if (probe.platform === "darwin") {
    const gnuTar = await find(probe, "gtar");
    if (gnuTar) {
      tarPath = gnuTar;
      extractArgs.push("--delay-directory-restore");
    } else {
      tarPath = await find(probe, "tar");
      flavour = "bsd";
    }
  } else {
    tarPath = await find(probe, "tar");
  }

  if (!tarPath) {
    throw new Error("The local cache needs `tar` on PATH, but it was not found.");
  }

  const compress = await firstProgram(probe, ["zstdmt", "zstd"]);
  const decompress = await firstProgram(probe, ["unzstd", "zstd"]);
  if (!compress || !decompress) {
    throw new Error("The local cache needs `zstd` on PATH, but it was not found.");
  }

  return {
    tarPath,
    flavour,
    createArgs,
    extractArgs,
    compressArgs: ["--use-compress-program", compress],
    decompressArgs: ["--use-compress-program", decompress],
  };
}

let cached: Promise<TarTool> | undefined;

/** The real probe, resolved at most once per process. A failure is not cached. */
export function tarTool(): Promise<TarTool> {
  cached ??= detectTarTool({
    platform: process.platform,
    env: process.env,
    which: (tool) => io.which(tool, false),
    exists: (file) => fs.promises.access(file).then(() => true, () => false),
  }).catch((e) => {
    cached = undefined;
    throw e;
  });
  return cached;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Prove the Windows test has teeth**

Temporarily replace the `throw new Error(...)` in the `win32` branch with `tarPath = "tar"; flavour = "bsd";` — a silent degrade.

Run: `npm test`
Expected: FAIL — "Windows without GNU tar fails loud, naming what is missing" no longer rejects.

Revert and re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tarTool.ts src/tarTool.test.ts
git commit -m "feat(local): probe tar flavour and zstd program per platform"
```

---

### Task 3: Rewrite `LocalCache` onto directory entries

Replace the absolute-path archive with a directory of per-root archives. This removes `-P`, `memberMatcher`, the `-xvf` stdout parse, and the zero-overlap miss branch.

**Files:**
- Rewrite: `src/localCache.ts`
- Rewrite: `src/localCache.test.ts`

**Interfaces:**
- Consumes: `rootTable`, `groupByRoot`, `resolveToken` from `src/cacheRoots.ts`; `tarTool` and `TarTool` from `src/tarTool.ts`; `exists` and `GhCache` from `src/utils.ts`.
- Produces: `createLocalCache(configuredDir: string, env?: NodeJS.ProcessEnv): GhCache`. The `env` parameter is optional and trailing, defaulting to `process.env`, so `src/utils.ts`'s existing `createLocalCache(dir)` call is unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/localCache.test.ts`:

```ts
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

test("an archive whose token has no root here is skipped with a warning", async (t) => {
  const { cargoHome, workspace, cacheDir, env } = await sandbox(t);
  await writeTree(path.join(cargoHome, "registry"), { "a.txt": "a" });
  await writeTree(path.join(workspace, "target"), { "b.txt": "b" });
  await createLocalCache(cacheDir, env).saveCache(
    [path.join(cargoHome, "registry"), path.join(workspace, "target")],
    KEY,
  );
  await fs.promises.rm(path.join(cargoHome, "registry"), { recursive: true });
  await fs.promises.rm(path.join(workspace, "target"), { recursive: true });

  // A machine with no GITHUB_WORKSPACE: the workspace archive cannot be placed.
  const partial = createLocalCache(cacheDir, { CARGO_HOME: cargoHome });
  let restored: string | undefined;
  const warned = await warnings(async () => {
    restored = await partial.restoreCache([path.join(cargoHome, "registry")], KEY);
  });

  assert.equal(restored, KEY, "a partial restore that delivered something is still a hit");
  assert.equal(warned.length, 1, `expected one warning, got ${JSON.stringify(warned)}`);
  assert.match(warned[0]!, /workspace/);
  assert.equal(fs.existsSync(path.join(cargoHome, "registry", "a.txt")), true);
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
    warned.some((w) => /nothing/i.test(w)),
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

  assert.equal(await cache.restoreCache([tree], KEY, RESTORE_KEYS), "v1-rust-111");
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
  await cache.saveCache([tree], KEY);

  await fs.promises.rm(tree, { recursive: true });
  assert.equal(await cache.restoreCache([tree], KEY), KEY);
  assert.equal(await fs.promises.readFile(path.join(tree, "a.txt"), "utf8"), "first");
  assert.deepEqual(await fs.promises.readdir(cacheDir), [KEY], "no temp directory may survive");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `createLocalCache` does not accept a second argument, entries are files not directories, and the relocation test restores nothing.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `src/localCache.ts`:

```ts
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { groupByRoot, resolveToken, rootTable } from "./cacheRoots.js";
import { tarTool } from "./tarTool.js";
import { exists, GhCache } from "./utils.js";

const SUFFIX = ".tar.zst";

/**
 * A filesystem cache. An entry is a directory `<cacheDir>/<key>/` holding one archive per root,
 * named for that root's token. Members are relative to their root, so an entry saved on one
 * machine restores correctly on another whose roots sit elsewhere.
 *
 * It knows nothing about other caches or about layering; compose it with `createLayeredCache`.
 */
export function createLocalCache(configuredDir: string, env: NodeJS.ProcessEnv = process.env): GhCache {
  // Resolved once, so no entry can ever land somewhere that depends on the process's cwd.
  const cacheDir = configuredDir.trim() ? path.resolve(configuredDir.trim()) : "";
  const roots = rootTable(env);

  /** The entry directory for `key`. A key is only ever a name, never a path. */
  function entryPath(key: string): string {
    if (!cacheDir) {
      throw new Error("The local cache has no directory: `cache-local-path` is empty.");
    }
    if (!key || key.includes("/") || key.includes("\\") || key.includes("..")) {
      throw new Error(`The cache key \`${key}\` cannot be used as a local cache file name.`);
    }
    return path.join(cacheDir, key);
  }

  /** The key of the most recently written entry matching `prefix`, if any. */
  async function findByPrefix(prefix: string): Promise<string | undefined> {
    const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
    let best: { key: string; mtimeMs: number } | undefined;
    for (const entry of entries) {
      // Dot-prefixed directories are half-written temporaries, and must never be served.
      if (!entry.isDirectory() || entry.name.startsWith(".") || !entry.name.startsWith(prefix)) {
        continue;
      }
      const { mtimeMs } = await fs.promises.stat(path.join(cacheDir, entry.name));
      if (!best || mtimeMs > best.mtimeMs) {
        best = { key: entry.name, mtimeMs };
      }
    }
    return best?.key;
  }

  async function findKey(primaryKey: string, restoreKeys: string[]): Promise<string | undefined> {
    if (await exists(entryPath(primaryKey))) {
      return primaryKey;
    }
    if (!(await exists(cacheDir))) {
      return undefined;
    }
    for (const prefix of restoreKeys) {
      const key = await findByPrefix(prefix);
      if (key) {
        return key;
      }
    }
    return undefined;
  }

  return {
    isFeatureAvailable() {
      if (!cacheDir) {
        core.warning("The local cache is unavailable: no `cache-local-path` was configured.");
        return false;
      }
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.accessSync(cacheDir, fs.constants.W_OK);
        return true;
      } catch (e) {
        core.warning(`The local cache directory ${cacheDir} is not writable: ${e}`);
        return false;
      }
    },

    async restoreCache(_paths, primaryKey, restoreKeys = [], options) {
      // `findKey` calls `entryPath`, which validates the key before any filesystem work.
      const key = await findKey(primaryKey, restoreKeys);
      if (!key) {
        core.info(`No local cache entry for "${primaryKey}" in ${cacheDir}.`);
        return undefined;
      }
      if (options?.lookupOnly) {
        core.info(`Found "${key}" in the local cache at ${cacheDir}.`);
        return key;
      }

      const tool = await tarTool();
      const dir = entryPath(key);
      const archives = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(SUFFIX));

      let restored = 0;
      for (const archive of archives) {
        const token = archive.slice(0, -SUFFIX.length);
        const target = resolveToken(token, roots);
        if (!target) {
          core.warning(
            `Skipping "${archive}" from the local cache entry "${key}": this machine has no` +
              ` "${token}" root, so there is nowhere to put it.`,
          );
          continue;
        }
        await fs.promises.mkdir(target, { recursive: true });
        await exec.exec(
          tool.tarPath,
          [...tool.extractArgs, ...tool.decompressArgs, "-xf", path.join(dir, archive), "-C", target],
          { silent: true },
        );
        restored++;
      }

      if (!restored) {
        // Reported as a miss, not a hit: a hit that delivered nothing stops a layered stack from
        // consulting the next layer, and stops `restore.ts` from ever re-saving under this key.
        core.warning(
          `The local cache entry "${key}" restored nothing on this machine: none of its` +
            ` ${archives.length} archive(s) map to a root that exists here. Treating it as a miss.`,
        );
        return undefined;
      }

      core.info(`Restored "${key}" from the local cache at ${cacheDir} (${restored} archive(s)).`);
      return key;
    },

    async saveCache(paths, key) {
      const entry = entryPath(key);
      const tool = await tarTool();
      await fs.promises.mkdir(cacheDir, { recursive: true });

      const present: string[] = [];
      for (const p of paths) {
        if (await exists(p)) {
          present.push(path.resolve(p));
        } else {
          core.debug(`Not caching ${p} locally: it does not exist.`);
        }
      }
      if (!present.length) {
        throw new Error(`None of the paths to cache under "${key}" exist: ${paths.join(", ")}`);
      }

      // A reader must see either a whole entry or none. The entry is built under a temp name and
      // renamed in, and a directory rename is atomic where writing archives in place is not.
      const temp = path.join(cacheDir, `.${key}.${randomUUID()}.tmp`);
      await fs.promises.mkdir(temp, { recursive: true });
      let size = 0;
      try {
        for (const [token, { dir, members }] of groupByRoot(present, roots)) {
          const archive = path.join(temp, token + SUFFIX);
          await exec.exec(
            tool.tarPath,
            [...tool.createArgs, ...tool.compressArgs, "-cf", archive, "-C", dir, ...members],
            { silent: true },
          );
          size += (await fs.promises.stat(archive)).size;
        }
      } catch (e) {
        // An archive failed to build: nothing to keep, and the caller must hear about it.
        await fs.promises.rm(temp, { recursive: true, force: true });
        throw e;
      }

      try {
        await fs.promises.rename(temp, entry);
      } catch (e) {
        await fs.promises.rm(temp, { recursive: true, force: true });
        // First writer wins. A rename onto a populated directory fails rather than replacing it,
        // so a concurrent saver observes either a complete entry or none — never a merge. Any
        // other rename failure is a real error and must not be mistaken for a lost race.
        if (!(await exists(entry))) {
          throw e;
        }
        core.info(`The local cache already holds "${key}"; keeping the existing entry.`);
        return size;
      }

      core.info(`Saved "${key}" to the local cache at ${entry} (${size} bytes).`);
      return size;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all `localCache`, `cacheRoots`, `tarTool`, `layeredCache` and `utils` tests green.

- [ ] **Step 5: Prove the relocation test has teeth**

Temporarily change the extract invocation to use the *saving* machine's layout by replacing
`"-C", target` with `"-C", path.dirname(target)`.

Run: `npm test`
Expected: FAIL — "relocation: an entry restores under a different root than it was saved from" reports a mismatched tree.

Revert and re-run: PASS.

- [ ] **Step 6: Prove the concurrency test has teeth**

Temporarily replace the atomic build-and-rename in `saveCache` with a non-atomic write in place:
set `const temp = entry;` and delete the `await fs.promises.rename(temp, entry);` line.

Run: `npm test`
Expected: FAIL — "concurrent saves of one key never expose a partial entry" observes more than one distinct archive state.

Revert both edits and re-run: PASS.

- [ ] **Step 7: Prove the nothing-restored test has teeth**

Temporarily change `if (!restored)` to `if (false)`.

Run: `npm test`
Expected: FAIL — "an entry that could deliver nothing at all is a miss, not a hit" gets `KEY` where `undefined` was expected.

Revert and re-run: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/localCache.ts src/localCache.test.ts
git commit -m "feat(local): store entries as per-root archives so they relocate across machines"
```

---

### Task 4: Three-OS integration workflow

The only evidence that macOS and Windows work. Unit tests run on Linux and cannot demonstrate the thing this branch exists to fix.

**Files:**
- Modify: `.github/workflows/local-cache.yml`

**Interfaces:**
- Consumes: the `local` and `local,github` providers wired in on `feat/layered-local-cache`; the inputs `cache-provider`, `cache-local-path`, `cache-layer-strategy`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Read the existing workflow and the template it was modelled on**

Read `.github/workflows/local-cache.yml` and `.github/workflows/warpbuild.yml`. The existing file has four jobs (`local-save`, `local-restore`, `warm-github-for-writeback`, `layered-write-back`) pinned to `ubuntu-latest`.

- [ ] **Step 2: Convert every job to a three-OS matrix**

For each of the four jobs, replace `runs-on: ubuntu-latest` with:

```yaml
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
```

Three changes each job needs alongside it:

1. **Give every job's cache path and key an OS component**, so the three matrix legs never share an entry. Wherever the workflow sets `cache-local-path`, make it OS-specific, and add `${{ matrix.os }}` to any `shared-key`/`prefix-key`:

```yaml
        with:
          workspaces: tests
          cache-provider: local
          cache-local-path: ${{ runner.temp }}/rust-local-cache
          shared-key: local-${{ matrix.os }}-${{ github.run_id }}
```

`${{ runner.temp }}` is set on all three runners and is writable, which a hard-coded `/mnt/...` is not.

2. **Make every `run:` step cross-platform.** Any step using bash syntax must declare it explicitly, because Windows defaults to PowerShell:

```yaml
      - name: Assert the local cache entry exists
        shell: bash
        run: |
          entry_count=$(find "${{ runner.temp }}/rust-local-cache" -maxdepth 1 -mindepth 1 -type d | wc -l)
          if [ "$entry_count" -eq 0 ]; then
            echo "No local cache entry was created." >&2
            ls -la "${{ runner.temp }}/rust-local-cache" >&2 || true
            exit 1
          fi
          echo "local cache holds $entry_count entr(ies)"
          find "${{ runner.temp }}/rust-local-cache" -maxdepth 2 -mindepth 1
```

Note this asserts on *directories*, not `*.tar.zst` files — the entry layout changed in Task 3. Update every existing assertion in the file that refers to `<key>.tar.zst` to refer to the entry directory and the archives inside it.

3. **Keep the `if:` guard consistent with the rest of the repo**: `if: github.repository == 'Swatinem/rust-cache' || github.repository == 'shkolnik/rust-cache'`.

- [ ] **Step 3: Add a relocation job**

Append a fifth job that proves the branch's purpose in real CI: save under one `CARGO_HOME`, restore under another, from the same local cache directory.

```yaml
  local-relocate:
    if: github.repository == 'Swatinem/rust-cache' || github.repository == 'shkolnik/rust-cache'
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    name: Relocate a local cache entry on ${{ matrix.os }}
    runs-on: ${{ matrix.os }}
    env:
      CARGO_TERM_COLOR: always
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - run: rustup toolchain install stable --profile minimal --no-self-update

      - name: Save under the first CARGO_HOME
        uses: ./
        with:
          workspaces: tests
          cache-provider: local
          cache-local-path: ${{ runner.temp }}/relocate-cache
          shared-key: relocate-${{ matrix.os }}-${{ github.run_id }}
        env:
          CARGO_HOME: ${{ runner.temp }}/cargo-a

      - run: cargo check
        working-directory: tests
        env:
          CARGO_HOME: ${{ runner.temp }}/cargo-a

      - name: Show the entry that was written
        shell: bash
        run: find "${{ runner.temp }}/relocate-cache" -maxdepth 2 -mindepth 1

      - name: Restore under a different CARGO_HOME
        uses: ./
        with:
          workspaces: tests
          cache-provider: local
          cache-local-path: ${{ runner.temp }}/relocate-cache
          shared-key: relocate-${{ matrix.os }}-${{ github.run_id }}
        env:
          CARGO_HOME: ${{ runner.temp }}/cargo-b

      - name: Assert the registry landed under the second CARGO_HOME
        shell: bash
        run: |
          if [ ! -d "${{ runner.temp }}/cargo-b/registry" ]; then
            echo "The entry did not relocate: no registry under cargo-b." >&2
            find "${{ runner.temp }}/cargo-b" -maxdepth 2 -mindepth 1 >&2 || true
            exit 1
          fi
          echo "relocated into cargo-b/registry"
```

The `save` half of this job runs in the action's post step, so the "Show the entry" step must come *after* the `cargo check` step but the entry is only written at job end — if the assertion proves unreachable in that shape, drive `dist/restore.js` and `dist/save.js` by hand exactly as the existing `local-save` job in this file already does, and mirror that job's `$GITHUB_STATE` bridging.

- [ ] **Step 4: Validate the workflow file parses**

Run:
```bash
node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/local-cache.yml','utf8');if(!/matrix:/.test(s))throw new Error('no matrix');console.log('read ok, '+s.split('\n').length+' lines')"
npx --yes yaml-lint .github/workflows/local-cache.yml 2>/dev/null || echo "(yaml-lint unavailable; relying on CI to parse)"
```
Expected: no throw.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/local-cache.yml
git commit -m "test(local): exercise the local and layered providers on all three OSes"
```

- [ ] **Step 6: Report, do not merge**

Report to the controller that the workflow is committed but **unproven** — it cannot be validated without a push, and pushing is the controller's call. Do not push.

---

### Task 5: Documentation and bundle rebuild

Last task. Anything committed after it re-stales `dist/`, and `action.yml` runs `dist/`, not `src/`.

**Files:**
- Modify: `README.md` (the `### The `local` provider` section, currently around lines 240-271)
- Modify: `dist/` (generated)

**Interfaces:**
- Consumes: the behaviour implemented in Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Rewrite the `local` provider README section**

Replace the body of `### The `local` provider` in `README.md` with the following, leaving the surrounding `## Layered caching` and `### Lookup strategies` sections untouched:

````markdown
### The `local` provider

An entry is a **directory**, `<cache-local-path>/<key>/`, holding one archive per
*root*:

```
<cache-local-path>/v0-rust-.../
  cargo.tar.zst        # members relative to CARGO_HOME
  workspace.tar.zst    # members relative to GITHUB_WORKSPACE
  home.tar.zst         # members relative to HOME
  abs-%2Fopt%2Fx.tar.zst   # members relative to /opt, restored to /opt
```

Each archive records member names *relative* to its root, and is extracted under
whatever that root is on the restoring machine. Entries therefore **relocate**: a
runner whose `CARGO_HOME` differs from the one that saved the entry still
restores it to the right place. This matters because the cache key covers the OS,
architecture, rustc version and lockfile hashes but never the workspace layout,
so two machines sharing one `cache-local-path` — over NFS, say — compute the same
key with different roots.

A path that sits under none of those roots gets an `abs-` archive named after its
percent-encoded absolute path, and restores to that exact location. Those entries
are **not** relocatable; the filename makes that visible rather than silent.

The entry is built in a temporary directory and `rename()`d into place, so a
reader sees either a complete entry or none. **The first writer wins:** if the key
already exists the new entry is discarded and the existing one kept. Two jobs
racing on one key therefore cannot corrupt it.

A restore looks for the exact key first, then for each restore key as a directory
name prefix, preferring the most recently written match.

Requirements:

- **GNU tar and zstd on `PATH`.** Linux and macOS runners have them (macOS uses
  `gtar` if present, otherwise stock BSD tar). On **Windows** the provider uses
  Git for Windows' GNU tar at `%PROGRAMFILES%\Git\usr\bin\tar.exe`; Windows
  *without* Git for Windows is unsupported and fails with an explicit error
  rather than degrading silently.

Limitations, all deliberate:

- **There is no eviction and no size limit.** The directory grows without bound;
  pruning it is the operator's job. A saver killed mid-write can leave a
  dot-prefixed `.tmp` directory behind. Lookups ignore those, but they accumulate.
- **A corrupt entry is sticky.** Because the first writer wins, re-running the job
  will not replace a bad entry — delete it by hand. This is the price of never
  exposing a partially-written entry, and it is cheap because the key is dominated
  by content hashes, so a second writer would be writing equivalent content anyway.
- **The key namespace is flat.** The GitHub backend scopes caches per repository;
  a `cache-local-path` does not. Sharing one directory between repositories or
  workspaces shares one namespace. A collision needs a matching job name, OS,
  architecture and lockfile hashes, so it is unlikely, but it is not prevented.
- **`abs-` paths do not relocate.** Anything outside `CARGO_HOME`,
  `GITHUB_WORKSPACE` and `HOME` restores to the absolute path it was saved from.
- **An entry whose archives all map to roots this machine lacks is reported as a
  miss**, not a hit, with a warning. A hit that delivered nothing would stop a
  layered stack from consulting the next layer and stop the action from re-saving.
````

- [ ] **Step 2: Check no other README claim is now false**

Run:
```bash
grep -nE "tar\.zst|absolute path|Linux-shaped|Linux only|not supported" README.md
```
Expected: every remaining hit is inside the section you just wrote, or is unrelated to the `local` provider. Fix any stale claim you find — in particular the old "It is Linux-shaped… macOS and Windows are not supported" bullet and the old "Archives record absolute paths" bullet must be gone.

- [ ] **Step 3: Run the full suite one more time**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Rebuild and commit the bundles**

Run:
```bash
npm run prepare
git status --porcelain dist/
```
Expected: `dist/restore.js` and `dist/save.js` show as modified. If `dist/` is **unchanged**, stop and report — it means the bundle does not include the new source, and `action.yml` would run the old code.

- [ ] **Step 5: Verify the bundle actually contains the new code**

Run:
```bash
grep -c "use-compress-program" dist/restore.js dist/save.js
grep -c "abs-" dist/save.js
```
Expected: non-zero counts. A zero here means the rebuild did not pick up `src/`.

- [ ] **Step 6: Verify the check-dist gate would pass**

Run:
```bash
npm run prepare && git diff --exit-code dist/ && echo "dist is reproducible"
```
Expected: `dist is reproducible`. A non-empty diff means the build is not deterministic and `check-dist` will fail in CI.

- [ ] **Step 7: Commit**

```bash
git add README.md dist/
git commit -m "docs(local): document relocatable entries; rebuild dist"
```

---

## Verification not covered by the tasks

These are the controller's, not an implementer's, and happen after Task 5:

1. **Push the branch and watch `local-cache.yml` actually run on all three OSes.** A green check is not evidence a job executed — open the run and confirm the macOS and Windows legs are present and passed.
2. **Confirm `check-dist` ran and passed** on the pushed commit.
3. **Watch a cold miss followed by a warm hit** in the real CI logs for at least one non-Linux leg. That, not the unit suite, is the acceptance evidence for this branch.
