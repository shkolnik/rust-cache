import * as core from "@actions/core";
import * as exec from "@actions/exec";
import fs from "fs";

import { createLayeredCache, LayerStrategy } from "./layeredCache.js";
import { createLocalCache } from "./localCache.js";

export function reportError(e: any) {
  const { commandFailed } = e;
  if (commandFailed) {
    core.error(`Command failed: ${commandFailed.command}`);
    core.error(commandFailed.stderr);
  } else {
    core.error(`${e.stack}`);
  }
}

export async function getCmdOutput(cmdFormat: string, cmd: string, options: exec.ExecOptions = {}): Promise<string> {
  cmd = cmdFormat.replace("{0}", cmd);
  let stdout = "";
  let stderr = "";
  try {
    await exec.exec(cmd, [], {
      silent: true,
      listeners: {
        stdout(data) {
          stdout += data.toString();
        },
        stderr(data) {
          stderr += data.toString();
        },
      },
      ...options,
    });
  } catch (e) {
    (e as any).commandFailed = {
      command: cmd,
      stderr,
    };
    throw e;
  }
  return stdout;
}

export interface GhCache {
  isFeatureAvailable: typeof import("@actions/cache").isFeatureAvailable;
  restoreCache: typeof import("@actions/cache").restoreCache;
  saveCache: (paths: string[], key: string) => Promise<string | number>;
}

export interface CacheProvider {
  name: string;
  cache: GhCache;
}

async function getSingleCacheProvider(cacheProvider: string): Promise<CacheProvider> {
  let cache: GhCache;
  switch (cacheProvider) {
    case "github":
      cache = await import("@actions/cache");
      break;
    case "warpbuild":
      cache = await import("@actions/warpbuild-cache");
      break;
    case "local": {
      const localPath = core.getInput("cache-local-path");
      if (!localPath) {
        throw new Error("The `local` `cache-provider` requires a `cache-local-path`.");
      }
      cache = createLocalCache(localPath);
      break;
    }
    default:
      throw new Error(`The \`cache-provider\` \`${cacheProvider}\` is not valid.`);
  }

  return {
    name: cacheProvider,
    cache: cache,
  };
}

function getLayerStrategy(): LayerStrategy {
  const strategy = core.getInput("cache-layer-strategy") || "exact-first";
  if (strategy !== "exact-first" && strategy !== "nearest-first") {
    throw new Error(
      `The \`cache-layer-strategy\` \`${strategy}\` is not valid. Use \`exact-first\` or \`nearest-first\`.`,
    );
  }
  return strategy;
}

export async function getCacheProvider(): Promise<CacheProvider> {
  const input = core.getInput("cache-provider");
  const names = input.split(",").map((name) => name.trim());
  if (names.some((name) => !name)) {
    throw new Error(`The \`cache-provider\` \`${input}\` is not valid: it has an empty entry.`);
  }
  const strategy = getLayerStrategy();

  const providers: CacheProvider[] = [];
  for (const name of names) {
    providers.push(await getSingleCacheProvider(name));
  }
  // A single provider is used as-is: no wrapper, and nothing an existing user can observe.
  if (providers.length === 1) {
    return providers[0];
  }

  return {
    name: names.join(","),
    cache: createLayeredCache(providers, strategy),
  };
}

export async function exists(path: string) {
  try {
    await fs.promises.access(path);
    return true;
  } catch {
    return false;
  }
}
