import fs from "node:fs";
import path from "node:path";

/** The tar invocation this machine supports, resolved once. */
export interface TarTool {
  tarPath: string;
  /** Flags valid only when creating. */
  createArgs: string[];
  /** Flags valid only when extracting. */
  extractArgs: string[];
  compressArgs: string[];
  decompressArgs: string[];
}

/**
 * The environment `detectTarTool` inspects, injected so every platform is testable from any one.
 * Every member is synchronous because `isFeatureAvailable()` is, and it probes the tooling.
 */
export interface TarProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The resolved location of `tool` on `PATH`, or `undefined` if it is not there. */
  which(tool: string): string | undefined;
  exists(file: string): boolean;
}

/** The first of `names` this machine has. Single words only: tar word-splits nothing for us. */
function firstProgram(probe: TarProbe, names: string[]): string | undefined {
  return names.find((name) => probe.which(name));
}

export function detectTarTool(probe: TarProbe): TarTool {
  let tarPath: string | undefined;
  const createArgs: string[] = [];
  const extractArgs: string[] = [];

  if (probe.platform === "win32") {
    // Windows ships BSD tar. `@actions/cache` pipes zstd through a temp file rather than
    // `--use-compress-program` for exactly that combination -- its `BSD_TAR_ZSTD` condition is
    // `BSD && zstd && IS_WINDOWS` (`lib/internal/tar.js`), and the `IS_WINDOWS` term is why stock
    // macOS BSD tar needs no such workaround. Rather than reimplement the workaround, require Git
    // for Windows' GNU tar and treat its absence as an error rather than a degrade.
    // `path.win32`, not `path`: detection must build a well-formed Windows path even when the
    // probe runs on a POSIX host (as it does under test), where the bare `path` module joins
    // with `/` and would mangle the drive-letter segment.
    const gnuTar = path.win32.join(probe.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "usr", "bin", "tar.exe");
    if (!probe.exists(gnuTar)) {
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
    const gnuTar = probe.which("gtar");
    if (gnuTar) {
      tarPath = gnuTar;
      extractArgs.push("--delay-directory-restore"); // GNU-only; stock BSD tar runs without it.
    } else {
      tarPath = probe.which("tar");
    }
  } else {
    tarPath = probe.which("tar");
  }

  if (!tarPath) {
    throw new Error("The local cache needs `tar` on PATH, but it was not found.");
  }

  const compress = firstProgram(probe, ["zstdmt", "zstd"]);
  const decompress = firstProgram(probe, ["unzstd", "zstd"]);
  if (!compress || !decompress) {
    throw new Error("The local cache needs `zstd` on PATH, but it was not found.");
  }

  return {
    tarPath,
    createArgs,
    extractArgs,
    compressArgs: ["--use-compress-program", compress],
    decompressArgs: ["--use-compress-program", decompress],
  };
}

/** `which`, synchronously and without a dependency: `@actions/io`'s only form is async. */
function whichSync(env: NodeJS.ProcessEnv, tool: string): string | undefined {
  const extensions =
    process.platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const dir of (env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, tool + extension);
      try {
        if (fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        // Not there, or not executable by us: keep looking.
      }
    }
  }
  return undefined;
}

let cached: TarTool | undefined;

/** The real probe, resolved at most once per process. A failure is not cached. */
export function tarTool(): TarTool {
  cached ??= detectTarTool({
    platform: process.platform,
    env: process.env,
    which: (tool) => whichSync(process.env, tool),
    exists: (file) => fs.existsSync(file),
  });
  return cached;
}
