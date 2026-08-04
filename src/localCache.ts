import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { exists, GhCache } from "./utils.js";

const SUFFIX = ".tar.zst";

/**
 * Consumes `tar -v`'s member listing chunk by chunk, recording which of `wanted` the archive
 * actually supplies. Streamed rather than collected: an entry can hold a million members.
 */
function memberMatcher(wanted: string[], supplied: Set<string>): (chunk: Buffer) => void {
  let tail = "";
  return (chunk) => {
    if (supplied.size === wanted.length) {
      return;
    }
    const lines = (tail + chunk.toString()).split("\n");
    // tar terminates every member with a newline, so the remainder is always an incomplete line.
    tail = lines.pop() ?? "";
    for (const line of lines) {
      const member = line.replace(/\/+$/, "");
      for (const root of wanted) {
        if (member === root || member.startsWith(root + path.sep)) {
          supplied.add(root);
        }
      }
    }
  };
}

/**
 * A filesystem cache, one entry per key at `<cacheDir>/<key>.tar.zst`.
 *
 * It knows nothing about other caches or about layering; compose it with `createLayeredCache`.
 */
export function createLocalCache(configuredDir: string): GhCache {
  // Resolved once, so no entry can ever land somewhere that depends on the process's cwd.
  const cacheDir = configuredDir.trim() ? path.resolve(configuredDir.trim()) : "";

  /**
   * The archive holds absolute member names (`tar -P`), so entries restore in place and a key
   * is only ever a file name, never a path.
   */
  function entryPath(key: string): string {
    if (!cacheDir) {
      throw new Error("The local cache has no directory: `cache-local-path` is empty.");
    }
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

    async restoreCache(paths, primaryKey, restoreKeys = [], options) {
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

      // The archive's absolute member names decide where the entry lands, so a caller's `paths` can
      // only be checked, never applied. The cache key does not cover the workspace layout, so an
      // entry saved from different paths is a real possibility and must not restore in silence.
      const wanted = [...new Set(paths.map((p) => path.resolve(p)))];
      const supplied = new Set<string>();
      await exec.exec("tar", ["-P", "--use-compress-program=zstd -d", "-xvf", entryPath(key)], {
        silent: true,
        listeners: { stdout: memberMatcher(wanted, supplied) },
      });

      if (wanted.length && !supplied.size) {
        // Reported as a miss, not a hit: a hit here would be an exact-key match that delivered
        // nothing, which stops a layered stack from consulting the next layer and stops the action
        // from re-saving. Both leave the bad entry in place forever.
        core.warning(
          `The local cache entry "${key}" holds none of the requested paths (${wanted.join(", ")});` +
            ` it was saved from a different layout and has been restored to its own recorded locations instead.` +
            ` Treating it as a miss.`,
        );
        return undefined;
      }

      core.info(
        `Restored "${key}" from the local cache at ${cacheDir}` +
          ` (${supplied.size}/${wanted.length} of the requested paths).`,
      );
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
