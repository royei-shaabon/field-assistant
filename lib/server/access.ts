// Optional gate for the technician area: with ACCESS_CODE set, a phone must enter the code once
// before it can list knowledge bases, ask, or open a source document. A signed-in implementer
// passes too. Without ACCESS_CODE the technician area is open to anyone with the link.
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { adminState } from "./admin-auth";

export const ACCESS_COOKIE = "kb_access";

const token = (code: string) => createHmac("sha256", code).update("kb-technician-access-v1").digest("hex");

export function checkAccessCode(code: string): string | null {
  const real = process.env.ACCESS_CODE;
  if (!real) return null;
  const a = Buffer.from(token(code.trim()));
  const b = Buffer.from(token(real));
  return timingSafeEqual(a, b) ? token(real) : null;
}

export async function technicianAllowed(): Promise<boolean> {
  const real = process.env.ACCESS_CODE;
  if (!real) return true;
  const cookie = (await cookies()).get(ACCESS_COOKIE)?.value ?? "";
  const expected = token(real);
  if (cookie.length === expected.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(expected))) return true;
  return (await adminState()) === "ok";
}

export const needsCode = () => Response.json({ error: "access_code" }, { status: 401 });
