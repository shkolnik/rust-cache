/** Helpers shared by the `*.test.ts` files. Not part of the action's bundles. */

/** The `::warning::` lines `@actions/core` emits while `body` runs. */
export async function warnings(body: () => Promise<unknown>): Promise<string[]> {
  const written: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk: any, ...rest: any[]) => {
    written.push(String(chunk));
    return original.call(process.stdout, chunk, ...(rest as [any, any]));
  };
  try {
    await body();
  } finally {
    process.stdout.write = original;
  }
  return written
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("::warning::"));
}
