import type { Metadata } from "next";
import { AdminApp } from "../../../components/AdminApp";

export const metadata: Metadata = { title: "ניהול מאגרי ידע" };

// The implementer's area of one environment. The server checks the environment and the
// session on every request.
export default function EnvAdmin() {
  return <AdminApp />;
}
