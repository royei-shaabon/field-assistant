// The two gates: the implementer password and the optional technician access code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccessCode } from "../lib/server/access";
import { checkPassword } from "../lib/server/admin-auth";

test("access code and admin password: only the exact value yields a token, and never the value itself", () => {
  process.env.ACCESS_CODE = "4821";
  process.env.ADMIN_PASSWORD = "SAMPLE-secret";
  assert.equal(checkAccessCode("0000"), null);
  assert.equal(checkAccessCode(""), null);
  const access = checkAccessCode(" 4821 ");
  assert.match(access ?? "", /^[0-9a-f]{64}$/);
  assert.equal(checkPassword("wrong"), null);
  const admin = checkPassword("SAMPLE-secret");
  assert.match(admin ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(access, admin);
  assert.ok(!access!.includes("4821") && !admin!.includes("SAMPLE-secret"));
  delete process.env.ACCESS_CODE;
  delete process.env.ADMIN_PASSWORD;
  assert.equal(checkAccessCode("4821"), null, "no code configured: nothing to match");
  assert.equal(checkPassword(""), null);
});
