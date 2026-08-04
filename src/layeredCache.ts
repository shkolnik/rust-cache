import * as core from "@actions/core";

import { CacheProvider, GhCache } from "./utils.js";

export type LayerStrategy = "exact-first" | "nearest-first";

type RestoreOptions = Parameters<GhCache["restoreCache"]>[3];

/**
 * Composes providers into a single cache, ordered nearest (cheapest) first.
 *
 * A layer that fails degrades to the next one, and never fails the run.
 */
export function createLayeredCache(providers: CacheProvider[], strategy: LayerStrategy): GhCache {
  async function restoreFrom(
    provider: CacheProvider,
    paths: string[],
    key: string,
    restoreKeys: string[],
    options: RestoreOptions,
    enableCrossOsArchive: boolean | undefined,
  ): Promise<string | undefined> {
    try {
      return await provider.cache.restoreCache(paths.slice(), key, restoreKeys, options, enableCrossOsArchive);
    } catch (e) {
      core.warning(`Cache layer "${provider.name}" failed to restore: ${e}`);
      return undefined;
    }
  }

  /**
   * Populates the layers nearer than the one that served `key`.
   *
   * This has to happen here rather than in `saveCache`: `restore.ts` only calls `config.saveState()`
   * when the restored key is not an exact match, and `save.ts` does nothing without that state, so
   * an exact hit never reaches `saveCache` at all.
   */
  async function writeBack(nearer: CacheProvider[], paths: string[], key: string, options: RestoreOptions) {
    if (!nearer.length) {
      return;
    }
    if (options?.lookupOnly) {
      core.info(`Not writing "${key}" back: nothing was downloaded.`);
      return;
    }
    for (const provider of nearer) {
      try {
        await provider.cache.saveCache(paths.slice(), key);
        core.info(`Wrote "${key}" back to cache layer "${provider.name}".`);
      } catch (e) {
        core.warning(`Cache layer "${provider.name}" failed to store the write-back of "${key}": ${e}`);
      }
    }
  }

  return {
    isFeatureAvailable() {
      return providers.some((provider) => {
        try {
          return provider.cache.isFeatureAvailable();
        } catch (e) {
          core.warning(`Cache layer "${provider.name}" is unavailable: ${e}`);
          return false;
        }
      });
    },

    async restoreCache(paths, primaryKey, restoreKeys = [], options, enableCrossOsArchive) {
      // A single layer already tries the primary key before the restore keys, so an exact-only
      // pre-pass over it would only ever be a wasted round trip.
      const passes = strategy === "nearest-first" || providers.length === 1 ? [restoreKeys] : [[], restoreKeys];

      for (const keys of passes) {
        for (const [index, provider] of providers.entries()) {
          const restoredKey = await restoreFrom(provider, paths, primaryKey, keys, options, enableCrossOsArchive);
          if (!restoredKey) {
            continue;
          }
          core.info(`Cache layer "${provider.name}" served "${restoredKey}".`);
          await writeBack(providers.slice(0, index), paths, restoredKey, options);
          return restoredKey;
        }
      }
      return undefined;
    },

    async saveCache(paths, key) {
      let result: string | number | undefined;
      for (const provider of providers) {
        try {
          const saved = await provider.cache.saveCache(paths.slice(), key);
          result ??= saved;
        } catch (e) {
          core.warning(`Cache layer "${provider.name}" failed to save "${key}": ${e}`);
        }
      }
      if (result === undefined) {
        core.warning(`No cache layer stored "${key}".`);
        return -1;
      }
      return result;
    },
  };
}
