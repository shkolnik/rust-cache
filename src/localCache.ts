import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { groupByRoot, resolveToken, rootTable } from "./cacheRoots.js";
import { TarTool, tarTool } from "./tarTool.js";
import { exists, GhCache } from "./utils.js";

const SUFFIX = ".tar.zst";

/**
 * A filesystem cache. An entry is a directory `<cacheDir>/<key>/` holding one archive per root,
 * named for that root's token. Members are relative to their root, so an entry saved on one
 * machine restores correctly on another whose roots sit elsewhere.
 *
 * It knows nothing about other caches or about layering; compose it with `createLayeredCache`.
 */
export function createLocalCache(
  configuredDir: string,
  env: NodeJS.ProcessEnv = process.env,
  tool: () => TarTool = tarTool,
): GhCache {
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
      } catch (e) {
        core.warning(`The local cache directory ${cacheDir} is not writable: ${e}`);
        return false;
      }
      try {
        // Probed here, not left to the first `restoreCache`, so a host without `tar` or `zstd`
        // reports "unavailable" once instead of throwing from restore and then again from save.
        tool();
      } catch (e) {
        core.warning(`The local cache is unavailable: ${e instanceof Error ? e.message : e}`);
        return false;
      }
      return true;
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

      const tar = tool();
      const dir = entryPath(key);
      const archives = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(SUFFIX));

      let restored = 0;
      const failures: string[] = [];
      for (const archive of archives) {
        const token = archive.slice(0, -SUFFIX.length);
        const target = resolveToken(token, roots);
        if (!target) {
          failures.push(`"${archive}": this machine has no "${token}" root, so there is nowhere to put it`);
          continue;
        }
        await fs.promises.mkdir(target, { recursive: true });
        try {
          await exec.exec(
            tar.tarPath,
            [...tar.extractArgs, ...tar.decompressArgs, "-xf", path.join(dir, archive), "-C", target],
            { silent: true },
          );
        } catch (e) {
          // A corrupt or truncated archive must degrade like an unplaceable one: recorded, not
          // thrown. Throwing here would abort the loop mid-entry and reach `restore.ts` as
          // "nothing was saved" rather than as the incomplete restore it actually is.
          failures.push(`"${archive}": failed to extract: ${e}`);
          continue;
        }
        restored++;
      }

      if (restored !== archives.length || !archives.length) {
        // Anything short of the whole entry is a miss. Reporting a partial restore as an exact hit
        // would make `restore.ts` compute `match === true`, so it never calls `saveState()`,
        // `save.ts` no-ops, and a layered stack never consults the farther layer — leaving the
        // incomplete entry to be served forever, since the first writer also wins.
        core.warning(
          `The local cache entry "${key}" restored ${restored} of ${archives.length} archive(s), so it` +
            ` is reported as a miss and will be rebuilt.` +
            (failures.length ? ` Not restored: ${failures.join("; ")}.` : ""),
        );
        return undefined;
      }

      core.info(`Restored "${key}" from the local cache at ${cacheDir} (${restored} archive(s)).`);
      return key;
    },

    async saveCache(paths, key) {
      const entry = entryPath(key);
      const tar = tool();
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
            tar.tarPath,
            [...tar.createArgs, ...tar.compressArgs, "-cf", archive, "-C", dir, ...members],
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
        // A save that was asked to write and wrote nothing is a degrade, not routine info: this
        // is the only place that can say so, since the caller only sees a byte count.
        core.warning(
          `The local cache already holds "${key}"; keeping the existing entry and discarding the` +
            ` ${size} byte(s) just built.`,
        );
        return size;
      }

      core.info(`Saved "${key}" to the local cache at ${entry} (${size} bytes).`);
      return size;
    },
  };
}
