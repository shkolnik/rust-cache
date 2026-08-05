# Portable `LocalCache`: relocatable entries via a reversible root encoding

**Status:** approved design, not yet implemented
**Branch:** `feat/portable-local-cache`, stacked on `cd26941` (which is PR #1, still open)
**Supersedes:** the absolute-path (`tar -P`) entry format shipped on `feat/layered-local-cache`

---

## 1. Why

`LocalCache` currently archives with `tar -P`, so member names are absolute. Three consequences:

1. **It is Linux-only in practice.** `--use-compress-program=zstd -T0` is passed as a single argv token and
   relies on GNU tar to word-split it; absolute names carry Windows drive letters that GNU tar strips with a
   warning; `memberMatcher` compares tar's `/`-separated member names against `path.resolve()` output, which on
   Windows is `\`-separated and therefore never matches.
2. **Entries do not relocate.** The cache key covers OS, arch, rustc version, `CARGO*`/`RUST*` env and lockfile
   hashes — never the workspace layout. Two runners sharing one `cache-local-path` (an NFS mount is the obvious
   way to make a local tier pay off across machines) compute the *same* key with *different* roots, so an entry
   saved by one restores to the other's wrong locations.
3. **The mitigation is itself a hazard.** Consequence 2 forced a detection-and-degrade path: compare the
   archive's members against the requested paths, warn on zero overlap, and report a miss. That machinery is
   what the Windows separator bug breaks — and because a zero-overlap result is now a miss, the Windows failure
   mode is *every restore misses forever*, not a cosmetic warning.

Relocatable entries remove the cause rather than detecting the symptom.

## 2. Design

### 2.1 Entry layout

An entry is a **directory**, `<cacheDir>/<key>/`, containing one archive per *root*:

```
<cacheDir>/v0-rust-.../
  cargo.tar.zst                     # members relative to CARGO_HOME
  workspace.tar.zst                 # members relative to GITHUB_WORKSPACE
  abs-%2Fopt%2Fshared-cache.tar.zst # members relative to /opt, restored to /opt
```

Each archive is created with `-C <root>` and plain relative member names, and restored with
`-C <that root's value on this machine>`. Relocation falls out of the two `-C` values differing; there is no
manifest, no absolute member name, and no `-P`.

### 2.2 The root table

Derived inside `localCache.ts` from the environment alone. `LocalCache` never sees `CacheConfig`, so `config.ts`
stays untouched and the provider stays ignorant of the action's configuration.

| Token | Root |
|---|---|
| `cargo` | `CARGO_HOME`, else `$HOME/.cargo` |
| `workspace` | `GITHUB_WORKSPACE` |
| `home` | `HOME` |
| `abs-<pct>` | fallback for a path under no known root |

**Longest-prefix match wins**, so `~/.cargo/registry` is assigned to `cargo`, not `home`, and a workspace nested
under `$HOME` is assigned to `workspace`. Each requested path is assigned to exactly one root. A root whose
environment variable is unset contributes no entry to the table.

### 2.3 Encoding

The archive filename is the encoding, and it is the only place the root identity is recorded.

- Named roots produce exactly `<token>.tar.zst`.
- The fallback produces `abs-<encoded>.tar.zst`, where `<encoded>` percent-encodes every byte outside
  `[A-Za-z0-9._-]` as `%XX` (uppercase hex). This is injective, filename-safe on every target platform (no `/`,
  `\`, or `:` survives), and decodes without ambiguity.
- An `abs-` archive is created with `-C <dirname(path)>` and the member `<basename(path)>`, and restores to the
  same absolute location. It is **not** relocatable, by definition. Paths on a different Windows drive from every
  root land here naturally.

Encoding and decoding are pure functions taking the root table as an argument, so they are testable without
mutating `process.env`.

Three cases the rules above must settle explicitly, because each is reachable:

- **A requested path that *is* a root exactly** (e.g. a `cache-directories` entry equal to `GITHUB_WORKSPACE`)
  yields a relative path of `.`; the archive is created with `-C <root> .` and its members carry a `./` prefix,
  which restores correctly under a different root.
- **Several requested paths under one root** share a single archive with one member each — that is the point of
  grouping by root, and it is why the archive count is bounded by the root table rather than by the path count.
- **A token with no corresponding root on the restoring machine** (an entry holding `workspace.tar.zst` restored
  where `GITHUB_WORKSPACE` is unset) is skipped with a `core.warning` naming the token. If skipping leaves
  nothing restored at all, the restore reports a **miss** (`undefined`) rather than a hit. This preserves the
  principle established by the previous branch's final review: a hit that delivered nothing must never stop a
  layered stack from consulting the next layer, nor stop the action from re-saving.

The existing key validation is retained unchanged — a key containing `/`, `\`, `..`, or blank is rejected loudly,
since the key is still used directly as a filesystem name (now a directory name rather than a file name).

### 2.4 What this removes

`-P`, `memberMatcher`, the `-xvf` verbose-listing stdout parse, the zero-overlap warning, and the
"treat it as a miss" branch all disappear. The path-mismatch class stops existing for rooted paths rather than
being detected after the fact. The two Important findings from the previous branch's final review are
**superseded, not reverted** — the failure they guarded against is no longer reachable for rooted paths, and
`abs-` paths are documented as non-relocatable.

### 2.5 Tar portability

A lazily-resolved, cached tar probe, ported in shape from `@actions/cache`'s `getTarPath()` (about 25 lines).
Note that `@actions/cache` cannot be reused directly: its `package.json` `exports` map exposes only `"."`, so
deep-importing `lib/internal/tar.js` is blocked by Node and by rollup's resolver, and the functions it does
export (`createTar`/`extractTar`/`listTar`) implement the workspace-relative, manifest-based model this design
rejects. The primitives are not exported at all.

| Platform | tar selected | Compression args | Extra flags |
|---|---|---|---|
| Linux | GNU | `['--use-compress-program', <zstd>]` | — |
| macOS | `gtar` if present, else stock BSD | same | `--delay-directory-restore` (GNU only) |
| Windows | GNU from `%PROGRAMFILES%\Git\usr\bin\tar.exe` | same | `--force-local` |
| Windows | BSD only (no Git for Windows) | **unsupported** | probe fails loud |

Two changes from today beyond detection:

- The flag and its program are **two argv entries**, never one word-split token. Whatever program name is chosen
  must therefore be a single word — no embedded flags — because tar's handling of a multi-word value is
  shell-dependent and differs between flavours.
- BSD tar on macOS needs no special case: `@actions/cache`'s piped workaround is guarded on `IS_WINDOWS`
  (`tar.js:136-141`), so stock macOS tar takes the ordinary `--use-compress-program` path.

Windows-without-GNU-tar is the one combination we do not claim. The probe fails loud there; in a layered stack
`LayeredCache` isolates the error and degrades to the next layer with a warning, and in a single-layer stack it
surfaces as an error annotation. This is deliberate: every platform we *do* claim runs one code path that CI
exercises, rather than three shapes where two are only reachable on runners we cannot reproduce.

### 2.6 Atomicity and concurrency

Build `<cacheDir>/.<key>.<uuid>.tmp/`, populate it with every archive, then `rename()` the directory to
`<cacheDir>/<key>`.

**First writer wins.** If the destination already exists — `EEXIST` or `ENOTEMPTY` on POSIX, `EPERM`/`EEXIST` on
Windows — the temp directory is removed and the outcome logged. Rename therefore only ever *creates*, so a
concurrent reader observes either a complete entry or none, which is the same guarantee the current
implementation provides and the property its concurrency test already pins. It also removes Windows as a special
case, since `MoveFileEx` replace-existing semantics never come into play.

The trade-off, which must be documented: a corrupt entry cannot be replaced by re-running the job. It has to be
deleted by hand. This is acceptable because the key is dominated by content hashes, so a second writer for an
existing key is writing equivalent content, and because `save.ts` only saves when the key was absent.

Prefix matching lists directory entries instead of files, skips dot-prefixed temporaries, and keeps the existing
most-recently-modified tiebreak.

### 2.7 Compatibility

Old flat `<key>.tar.zst` entries never match the new lookup and become dead files an operator can delete. No
migration path is provided: the previous format only ever ran on this fork, behind a PR that has not merged.

## 3. Testing

| Test | What it pins |
|---|---|
| Root encode/decode round trip | Table-driven, including Windows-shaped paths via `path.win32`; injective encoding, longest-prefix assignment, `abs-` fallback |
| **Relocation** | Save under root A, restore under root B, assert the tree lands under B — the test the design exists for |
| Round trip | Unchanged in intent: restored tree matches the original, contents and path set |
| Concurrency | Carried over to directory entries; teeth re-proven by regressing `rename()` to a non-atomic sequence |
| First-writer-wins | A second save of an existing key leaves the first entry intact and logs |
| Prefix match + tiebreak | Directory listing, dot-prefixed temps ignored |
| Missing tooling | The probe fails loud and names what is missing |
| `local-cache.yml` on a **3-OS matrix** | The only real proof for macOS and Windows |

The 3-OS integration matrix is the acceptance evidence for this branch. Unit tests run on Linux only and cannot
demonstrate the thing being fixed.

## 4. Scope

**In:** `src/localCache.ts`, `src/localCache.test.ts`, `.github/workflows/local-cache.yml`, the README's
limitations section.

**Out:** `createLocalCache(cacheDir)`'s signature is unchanged, so `src/layeredCache.ts`, `src/utils.ts`, and
`action.yml` need no edits. `src/config.ts`, `src/cleanup.ts`, `src/workspace.ts`, `src/restore.ts`, and
`src/save.ts` remain untouched, as on the previous branch. `dist/` must be rebuilt and committed, because
`action.yml` runs the bundles rather than `src/`.

**Non-goals:** eviction or size limits; repository scoping of the local namespace; supporting Windows without
GNU tar; making `abs-` paths relocatable.

## 5. Decisions to confirm during implementation

These are decided, not open. Each names what to do and the signal that would change it.

- **zstd program name.** Pass a single-word program (§2.5). Probe for `zstdmt`/`unzstd` as `@actions/cache` does;
  if absent, fall back to whatever single-word zstd binary the probe finds, and if none is found fail loud naming
  it. Do not paper over absence with a multi-word value — tar's handling of one is shell-dependent and differs
  between flavours, which is the class of bug this branch exists to remove.
- **`isFeatureAvailable()` stays a directory-writability check.** It is synchronous and the tar probe is async,
  so tooling failures surface from `restoreCache`/`saveCache` instead, where `LayeredCache` already isolates and
  logs them. Revisit only if the resulting degrade timing proves confusing in a real run.

## 6. Risks

- **The 3-OS matrix is the only evidence for two of the three platforms.** Unit tests run on Linux. A macOS or
  Windows defect is invisible until CI runs, and the fork's runner queue makes that a slow feedback loop. Expect
  several iterations on `local-cache.yml`, and treat a green Linux suite as proving nothing about the change's
  actual purpose.
- **First-writer-wins makes a corrupt entry sticky** (§2.6). Deliberate, but it means a bad archive persists
  until deleted by hand — the README must say so.
- **`abs-` paths remain non-relocatable.** Anything outside the root table behaves exactly as the current
  implementation does, including under a shared `cache-local-path`. The encoding makes this visible in the
  filename rather than silent, but it does not fix it.
