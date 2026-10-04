import assert from "node:assert/strict";
import { test } from "node:test";
import { GREETING, greet } from "../src/greeting.js";

test("greet uses the greeting", () => {
  assert.equal(greet("throng"), `${GREETING}, throng`);
});
