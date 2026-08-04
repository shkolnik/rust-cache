import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exists } from "./utils.js";

const thisFile = fileURLToPath(import.meta.url);

test("exists returns true for a path that exists", async () => {
  assert.equal(await exists(thisFile), true);
});

test("exists returns false for a path that does not exist", async () => {
  assert.equal(await exists(`${thisFile}.does-not-exist`), false);
});
