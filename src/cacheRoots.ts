import os from "node:os";
import nodePath from "node:path";

/** The shape of `node:path`'s platform-specific bindings (`path`, `path.posix`, `path.win32`). */
type PlatformPath = typeof nodePath;

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
 * The environment and the home directory are parameters rather than reads of `process.env` and
 * `os.homedir()` so every platform's behaviour is testable from any platform.
 *
 * `homeDir` must agree with what `config.ts` uses to build the paths it asks to cache, or those
 * paths fall under no root and become non-relocatable `abs-` archives with no warning. `config.ts`
 * derives them from `os.homedir()`, which already prefers `$HOME` on POSIX and `%USERPROFILE%` on
 * Windows and only falls back to the passwd entry when that is unset -- so reading `env.HOME` first
 * and `homeDir` second reproduces it exactly, including the container case where `HOME` is unset.
 */
export function rootTable(
  env: NodeJS.ProcessEnv,
  p: PlatformPath = nodePath,
  homeDir: string | undefined = os.homedir(),
): CacheRoot[] {
  const home = clean(env.HOME) ?? clean(homeDir);
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
function fold(value: string, p: PlatformPath): string {
  return p === nodePath.win32 ? value.toLowerCase() : value;
}

/** Which archive holds `target`, and under what member name. */
export function assignRoot(
  target: string,
  roots: CacheRoot[],
  p: PlatformPath = nodePath,
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
  p: PlatformPath = nodePath,
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
  p: PlatformPath = nodePath,
): string | undefined {
  if (token.startsWith(ABS_PREFIX)) {
    return p.dirname(decodePathToken(token.slice(ABS_PREFIX.length)));
  }
  return roots.find((root) => root.token === token)?.dir;
}
