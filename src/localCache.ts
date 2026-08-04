import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { exists, GhCache } from "./utils.js";

const SUFFIX = ".tar.zst";

/**
 * A filesystem cache, one entry per key at `<cacheDir>/<key>.tar.zst`.
 *
 * It knows nothing about other caches or about layering; compose it with `createLayeredCache`.
 */
export function createLocalCache(cacheDir: string): GhCache {
  /**
   * The archive holds absolute member names (`tar -P`), so entries restore in place and a key
   * is only ever a file name, never a path.
   */
  function entryPath(key: string): string {
    if (!key || key.includes("/") || key.includes("\\") || key.includes("..")) {
      throw new Error(`The cache key \`${key}\` cannot be used as a local cache file name.`);
    }
    return path.join(cacheDir, key + SUFFIX);
  }

  async function ensureTools() {
    // `tar` shells out to `zstd`, and reports its absence as a plain non-zero exit.
    await io.which("tar", true);
    await io.which("zstd", true);
  }

  /** The key of the most recently written entry matching `prefix`, if any. */
  async function findByPrefix(prefix: string): Promise<string | undefined> {
    const names = (await fs.promises.readdir(cacheDir)).filter(
      (name) => name.endsWith(SUFFIX) && name.startsWith(prefix),
    );
    let best: { key: string; mtimeMs: number } | undefined;
    for (const name of names) {
      const { mtimeMs } = await fs.promises.stat(path.join(cacheDir, name));
      if (!best || mtimeMs > best.mtimeMs) {
        best = { key: name.slice(0, -SUFFIX.length), mtimeMs };
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
      if (!cacheDir.trim()) {
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
      await ensureTools();

      const key = await findKey(primaryKey, restoreKeys);
      if (!key) {
        core.info(`No local cache entry for "${primaryKey}" in ${cacheDir}.`);
        return undefined;
      }
      if (options?.lookupOnly) {
        core.info(`Found "${key}" in the local cache at ${cacheDir}.`);
        return key;
      }

      await exec.exec("tar", ["-P", "--use-compress-program=zstd -d", "-xf", entryPath(key)]);
      core.info(`Restored "${key}" from the local cache at ${cacheDir}.`);
      return key;
    },

    async saveCache(paths, key) {
      await ensureTools();

      const archive = entryPath(key);
      await fs.promises.mkdir(cacheDir, { recursive: true });

      const present: string[] = [];
      for (const p of paths) {
        if (await exists(p)) {
          present.push(p);
        } else {
          core.debug(`Not caching ${p} locally: it does not exist.`);
        }
      }
      if (!present.length) {
        throw new Error(`None of the paths to cache under "${key}" exist: ${paths.join(", ")}`);
      }

      // A reader must see either the whole previous archive or the whole new one. `rename` within
      // a directory is atomic; writing the archive to its final name is not.
      const temp = path.join(cacheDir, `.${key}.${randomUUID()}.tmp`);
      try {
        await exec.exec("tar", ["-P", "--use-compress-program=zstd -T0", "-cf", temp, ...present]);
        await fs.promises.rename(temp, archive);
      } catch (e) {
        await fs.promises.rm(temp, { force: true });
        throw e;
      }

      const { size } = await fs.promises.stat(archive);
      core.info(`Saved "${key}" to the local cache at ${archive} (${size} bytes).`);
      return size;
    },
  };
}
