import { test } from "node:test";
import assert from "node:assert/strict";
import { allow, clientKey, reset } from "../lib/server/rate-limit";

test("rate limit: allows up to max in a window, then refuses until the window ends", () => {
  const limit = { max: 3, windowMs: 1000 };
  const t = 1_000_000;
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => allow("SAMPLE-a", limit, t + i)), [true, true, true, false, false]);
  assert.ok(allow("SAMPLE-b", limit, t), "another caller is not affected");
  assert.ok(allow("SAMPLE-a", limit, t + 1001), "a new window starts");
  allow("SAMPLE-a", limit, t + 1002);
  allow("SAMPLE-a", limit, t + 1003);
  assert.ok(!allow("SAMPLE-a", limit, t + 1004));
  reset("SAMPLE-a");
  assert.ok(allow("SAMPLE-a", limit, t + 1005), "a successful login clears the count");
});

test("the caller is the last forwarded address: the one the client cannot choose", () => {
  assert.equal(clientKey(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.7" } })), "203.0.113.7");
  assert.equal(clientKey(new Request("http://x")), "unknown");
});
