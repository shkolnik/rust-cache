# Rust Cache Action

A GitHub Action that implements smart caching for rust/cargo projects with
sensible defaults.

## Example usage

```yaml
- uses: actions/checkout@v6

# selecting a toolchain either by action or manual `rustup` calls should happen
# before the plugin, as the cache uses the current rustc version as its cache key
- run: rustup toolchain install stable --profile minimal

- uses: Swatinem/rust-cache@v2
  with:
    # The prefix cache key, this can be changed to start a new cache manually.
    # default: "v0-rust"
    prefix-key: ""

    # A cache key that is used instead of the automatic `job`-based key,
    # and is stable over multiple jobs.
    # default: empty
    shared-key: ""

    # An additional cache key that is added alongside the automatic `job`-based
    # cache key and can be used to further differentiate jobs.
    # default: empty
    key: ""

    # If the automatic `job`-based cache key should include the job id.
    # default: "true"
    add-job-id-key: ""

    # Whether the a hash of the rust environment should be included in the cache key.
    # This includes a hash of all Cargo.toml/Cargo.lock files, rust-toolchain files,
    # and .cargo/config.toml files (if present), as well as the specified 'env-vars'.
    # default: "true"
    add-rust-environment-hash-key: ""

    # A whitespace separated list of env-var *prefixes* who's value contributes
    # to the environment cache key.
    # The env-vars are matched by *prefix*, so the default `RUST` var will
    # match all of `RUSTC`, `RUSTUP_*`, `RUSTFLAGS`, `RUSTDOC_*`, etc.
    # default: "CARGO CC CFLAGS CXX CMAKE RUST"
    env-vars: ""

    # The cargo workspaces and target directory configuration.
    # These entries are separated by newlines and have the form
    # `$workspace -> $target`. The `$target` part is treated as a directory
    # relative to the `$workspace` and defaults to "target" if not explicitly given.
    # default: ". -> target"
    workspaces: ""

    # Additional non workspace directories to be cached, separated by newlines.
    cache-directories: ""

    # Determines whether workspace `target` directories are cached.
    # If `false`, only the cargo registry will be cached.
    # default: "true"
    cache-targets: ""

    # Determines if the cache should be saved even when the workflow has failed.
    # default: "false"
    cache-on-failure: ""

    # Determines which crates are cached.
    # If `true` all crates will be cached, otherwise only dependent crates will be cached.
    # Useful if additional crates are used for CI tooling.
    # default: "false"
    cache-all-crates: ""

    # Similar to cache-all-crates.
    # If `true` the workspace crates will be cached.
    # Useful if the workspace contains libraries that are only updated sporadically.
    # default: "false"
    cache-workspace-crates: ""

    # Determines whether the cache should be saved.
    # If `false`, the cache is only restored.
    # Useful for jobs where the matrix is additive e.g. additional Cargo features,
    # or when only runs from `master` should be saved to the cache.
    # default: "true"
    save-if: ""
    # To only cache runs from `master`:
    save-if: ${{ github.ref == 'refs/heads/master' }}

    # Determines whether the cache should be restored.
    # If `true` the cache key will be checked and the `cache-hit` output will be set
    # but the cache itself won't be restored
    # default: "false"
    lookup-only: ""

    # Specifies what to use as the backend providing cache
    # Can be set to "github", "warpbuild", or "local".
    # Several comma-separated providers, nearest first, are layered into a
    # single cache, see the "Layered caching" section below.
    # default: "github"
    cache-provider: ""
    # To check a local disk before going to the GitHub cache service:
    cache-provider: local,github

    # The directory the `local` cache provider stores its entries in.
    # Required by that provider, and unused by the others.
    # default: empty
    cache-local-path: ""

    # How several layered cache providers are searched.
    # Can be set to "exact-first" or "nearest-first", and has no effect
    # unless `cache-provider` names more than one provider.
    # default: "exact-first"
    cache-layer-strategy: ""

    # Determines whether to cache the ~/.cargo/bin directory.
    # default: "true"
    cache-bin: ""

    # A format string used to format commands to be run, i.e. `rustc` and `cargo`.
    # Must contain exactly one occurance of `{0}`, which is the formatting fragment
    # that will be replaced with the `rustc` or `cargo` command. This is necessary
    # when using Nix or other setup that requires running these commands within a
    # specific shell, otherwise the system `rustc` and `cargo` will be run.
    # default: "{0}"
    cmd-format: ""
    # To run within a Nix shell (using the default dev shell of a flake in the repo root):
    cmd-format: nix develop -c {0}
```

Further examples are available in the [.github/workflows](./.github/workflows/) directory.

## Outputs

**`cache-hit`**

This is a boolean flag that will be set to `true` when there was an exact cache hit.

## Cache Effectiveness

This action only caches the _dependencies_ of a crate, so it is more effective if
the dependency / own code ratio is higher.

It is also more effective for repositories with a `Cargo.lock` file. Library
repositories with only a `Cargo.toml` file have limited benefits, as cargo will
_always_ use the most up-to-date dependency versions, which may not be cached.

Usage with Stable Rust is the most effective, as a cache is tied to the Rust version.
Using it with Nightly Rust is less effective as it will throw away the cache every day,
unless a specific nightly build is being pinned.

## Cache Details

This action currently caches the following files/directories:

- `~/.cargo` (installed binaries, the cargo registry, cache, and git dependencies)
- `./target` (build artifacts of dependencies)

This cache is automatically keyed by:

- the github [`job_id`](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_id)
  (if `add-job-id-key` is `"true"`),
- the rustc release / host / hash (for all installed toolchains when
  available),
- the following values, if `add-rust-environment-hash-key` is `"true"`:
  - the value of some compiler-specific environment variables (eg. RUSTFLAGS, etc), and
  - a hash of all `Cargo.lock` / `Cargo.toml` files found anywhere in the repository (if present).
  - a hash of all `rust-toolchain` / `rust-toolchain.toml` files in the root of the repository (if present).
  - a hash of all `.cargo/config.toml` files in the root of the repository (if present).

An additional input `key` can be provided if the builtin keys are not sufficient.

Before being persisted, the cache is cleaned of:

- Any files in `~/.cargo/bin` that were present before the action ran (for example `rustc`).
- Dependencies that are no longer used.
- Anything that is not a dependency.
- Incremental build artifacts.
- Any build artifacts with an `mtime` older than one week.

In particular, the workspace crates themselves are not cached since doing so is
[generally not effective](https://github.com/Swatinem/rust-cache/issues/37#issuecomment-944697938).
For this reason, this action automatically sets `CARGO_INCREMENTAL=0` to disable
incremental compilation, so that the Rust compiler doesn't waste time creating
the additional artifacts required for incremental builds.

The `~/.cargo/registry/src` directory is not cached since it is quicker for Cargo
to recreate it from the compressed crate archives in `~/.cargo/registry/cache`.

The action will try to restore from a previous `Cargo.lock` version as well, so
lockfile updates should only re-build changed dependencies.

The action invokes `cargo metadata` to determine the current set of dependencies.

Additionally, the action automatically works around
[cargo#8603](https://github.com/rust-lang/cargo/issues/8603) /
[actions/cache#403](https://github.com/actions/cache/issues/403) which would
otherwise corrupt the cache on macOS builds.

## Cache Limits and Control

This specialized cache action is built on top of the upstream cache action
maintained by GitHub. The same restrictions and limits apply, which are
documented here:
[Caching dependencies to speed up workflows](https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows)

In particular, caches are currently limited to 10 GB in total and exceeding that
limit will cause eviction of older caches.

Caches from base branches are available to PRs, but not across unrelated
branches.

The caches can be controlled using the [Cache API](https://docs.github.com/en/rest/actions/cache)
which allows listing existing caches and manually removing entries.

## Layered caching

`cache-provider` accepts a comma-separated stack of providers, ordered nearest
(cheapest) first. With more than one entry the action layers them into a single
cache: a restore falls through the stack until some layer answers, and a save
writes to every layer. A single `cache-provider` value is used unwrapped, and
behaves exactly as it did before layering existed.

The motivating case is a self-hosted runner. Every job restores the same cargo
cache over the WAN, and with `add-job-id-key` (the default) each job has its own
entry, so a ten-job workflow pulls the whole payload ten times onto a host that
already had those bytes minutes earlier. Putting a `local` layer in front means
the network is only used when the disk cannot answer.

```yaml
- uses: Swatinem/rust-cache@v2
  with:
    cache-provider: local,github
    cache-local-path: /mnt/gha-cache/rust
    cache-layer-strategy: exact-first
```

`cache-local-path` must be a directory the job can write to, and must survive
between jobs for the layer to be worth anything — a path on the runner host, not
one inside a per-job container or workspace. It is created if it does not exist.

### The `local` provider

Entries are stored as `<cache-local-path>/<key>.tar.zst`. Archives are written
to a temporary file in the same directory and then `rename()`d into place, so a
job reading an entry never sees a half-written one even if two jobs save the
same key at the same time.

A restore looks for the exact key first, then for each restore key as a filename
prefix, preferring the most recently written match.

Limitations, all deliberate:

- **It is Linux-shaped.** It shells out to GNU `tar` (with
  `--use-compress-program=zstd` and `-P`) and `zstd`, both of which must be on
  `PATH`. macOS and Windows are not supported.
- **There is no eviction and no size limit.** The directory grows without bound;
  pruning it is the operator's job. A saver killed mid-write can also leave a
  `.tmp` file behind. Those are ignored by lookups, but they accumulate.
- **The key namespace is flat.** The GitHub backend scopes caches per
  repository; a `cache-local-path` does not. Sharing one directory between
  repositories or workspaces shares one namespace. A collision needs a matching
  job name, OS, architecture and lockfile hashes, so it is unlikely, but it is
  not prevented.
- **Archives record absolute paths.** The cache key does not cover the workspace
  layout, so if `workspaces` changes while the key does not, an entry can
  restore to the paths it was saved from rather than the ones being asked for.
  The provider warns when none of the requested paths appear in the archive; the
  remedy is to vary `prefix-key` or `shared-key` so the layouts get separate
  keys.

### Lookup strategies

`cache-layer-strategy` decides how a restore searches the stack. It only matters
with more than one layer.

| Strategy | Behaviour |
| --- | --- |
| `exact-first` (default) | Pass 1 asks every layer, in order, for the exact key only. Pass 2 asks every layer, in order, with the restore keys as well. The first hit in either pass wins. |
| `nearest-first` | A single pass, asking each layer for the exact key and the restore keys at once. The first layer to return anything wins. |

They differ in exactly one situation: a nearer layer holds a prefix match while
a farther layer holds the exact key. `exact-first` pays the download to get a
perfect cache; `nearest-first` pays nothing and lets cargo rebuild the delta.
Which is faster depends on the size of that delta, which is why both exist.
`exact-first` costs nothing in the warm case — a nearest-layer exact hit ends
pass 1 immediately and no other layer is contacted.

`exact-first`'s first pass assumes that asking a backend for a key with no
restore keys matches that key exactly rather than by prefix. That is GitHub's
documented behaviour, and it is what the `local` provider does, but it is an
assumption about the backend rather than something this action can enforce.

### What gets written where

| Restore outcome | Nearer layer written | Farther layer written |
| --- | --- | --- |
| Exact hit at the nearest layer | no | no |
| Nearest miss, farther layer **exact** hit | **yes** — write-back, during restore | no |
| Nearest miss, farther layer **partial** hit | yes — on save | yes — on save |
| Miss at every layer | yes — on save | yes — on save |

When a farther layer serves a hit, the nearer layers are populated from it
before the restore returns. That write-back happens during the action's
**restore** step and not its **save** step, which is not an implementation
detail: `src/restore.ts` only calls `config.saveState()` when the restored key
is *not* an exact match, and `src/save.ts` returns early when that state is
empty. On an exact hit the save step therefore never runs at all, and a
write-back placed there would never fire — silently, with a working cache that
simply never got faster.

The two rows that save to every layer fall out of that same rule: the save step
is only reached when the exact key was absent from every layer, so there is
nothing to decide and no bookkeeping about which layer hit.

### Failures

A layer that throws is logged as a warning and the next layer is tried; a
failing layer never fails the run. `@actions/cache` already treats cache-service
failures as non-fatal, and a stack of providers is not stricter than the
provider it wraps. A write-back that fails is warned about and otherwise
ignored. The cache is considered available if any layer is available.

Naming a provider that does not exist is still a hard error, as is
`cache-provider: local` without a `cache-local-path`.

## Debugging

The action prints detailed information about which information it considers
for its cache key, and it outputs more debug-only information about which
cleanup steps it performs before persisting the cache.

You can read up on how to [enable debug logging](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/enabling-debug-logging)
to see those details as well as further details related to caching operations.

## Known issues

- The cache cleaning process currently removes all the files from `~/.cargo/bin`
  that were present before the action ran (for example `rustc`), by default.
  This can be an issue on long-running self-hosted runners, where such state
  is expected to be preserved across runs. You can work around this by setting
  `cache-bin: "false"`.
