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
  assert.deepEqual(rootTable({}, path.posix, ""), []);
  assert.deepEqual(rootTable({ CARGO_HOME: "   " }, path.posix, ""), []);
});

/**
 * The case that makes this a parameter rather than a read of `env.HOME`: a container runner with
 * `HOME` unset. `config.ts` builds its cache paths from `os.homedir()`, which still resolves there,
 * so a root table that consulted only `env.HOME` would find no cargo root and silently turn
 * `~/.cargo/registry` into an `abs-` archive pinned to the saving machine's absolute path.
 */
test("the home directory falls back to os.homedir() when HOME is unset", () => {
  assert.deepEqual(rootTable({}, path.posix, "/root"), [
    { token: "cargo", dir: "/root/.cargo" },
    { token: "home", dir: "/root" },
  ]);
  assert.deepEqual(assignRoot("/root/.cargo/registry", rootTable({}, path.posix, "/root"), path.posix), {
    token: "cargo",
    dir: "/root/.cargo",
    member: "registry",
  });

  // `env.HOME` still wins where it is set, which is what `os.homedir()` itself does on POSIX.
  assert.equal(rootTable({ HOME: "/home/runner" }, path.posix, "/root")[0]!.dir, "/home/runner/.cargo");
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
  const roots = rootTable(env, path.win32, "");

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
  assert.equal(resolveToken("workspace", rootTable({ HOME: "/h" }, path.posix, ""), path.posix), undefined);
  assert.equal(resolveToken("nonsense", roots, path.posix), undefined);
});

test("relocation: the same member resolves under a different machine's roots", () => {
  const saver = rootTable({ CARGO_HOME: "/home/runner/.cargo" }, path.posix, "");
  const restorer = rootTable({ CARGO_HOME: "/mnt/big/cargo" }, path.posix, "");

  const assigned = assignRoot("/home/runner/.cargo/registry", saver, path.posix);
  assert.equal(assigned.member, "registry");
  assert.equal(resolveToken(assigned.token, restorer, path.posix), "/mnt/big/cargo");
});

test("a filesystem root cannot be cached", () => {
  assert.throws(() => assignRoot("/", [], path.posix), /cannot be cached/);
});
