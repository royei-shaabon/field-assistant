// The two gates (implementer password, technician access code) and their sessions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeMatches } from "../lib/server/access";
import { passwordMatches } from "../lib/server/admin-auth";
import { issueSession, validSession } from "../lib/server/session";

test("only the exact code or password matches; nothing matches when none is configured", async () => {
  process.env.ACCESS_CODE = "4821";
  process.env.ADMIN_PASSWORD = "SAMPLE-secret";
  assert.deepEqual(await Promise.all([codeMatches("0000"), codeMatches(""), codeMatches(" 4821 "), codeMatches("48210")]), [false, false, true, false]);
  assert.deepEqual(await Promise.all([passwordMatches("wrong"), passwordMatches("SAMPLE-secret"), passwordMatches("SAMPLE-secret ")]), [false, true, false]);
  delete process.env.ACCESS_CODE;
  delete process.env.ADMIN_PASSWORD;
  assert.deepEqual(await Promise.all([codeMatches("4821"), passwordMatches("")]), [false, false]);
});

test("sessions: unique per sign-in, bound to their kind, expiring, and useless once the secret changes", () => {
  process.env.ADMIN_PASSWORD = "SAMPLE-secret";
  process.env.ACCESS_CODE = "4821";
  const now = 1_800_000_000_000;
  const a = issueSession("admin", now);
  const b = issueSession("admin", now);
  assert.notEqual(a.token, b.token);
  assert.ok(!a.token.includes("SAMPLE-secret") && !issueSession("tech", now).token.includes("4821"));
  assert.ok(validSession("admin", a.token, now + 1000));
  assert.ok(!validSession("tech", a.token, now + 1000), "an admin session is not a technician session");
  assert.ok(!validSession("admin", a.token, now + 13 * 60 * 60 * 1000), "expired on the server, whatever the cookie says");
  const forged = a.token.replace(/\.(\d+)\./, (_, exp) => `.${Number(exp) + 999999}.`);
  assert.ok(!validSession("admin", forged, now + 1000), "a longer expiry breaks the signature");
  for (const bad of [undefined, "", "admin.1.2", "x".repeat(300), "admin.9999999999.aa.ééééé"]) assert.ok(!validSession("admin", bad, now));
  process.env.ADMIN_PASSWORD = "SAMPLE-changed";
  assert.ok(!validSession("admin", a.token, now + 1000), "changing the password signs everyone out");
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ACCESS_CODE;
});
