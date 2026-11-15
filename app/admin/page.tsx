import type { Metadata } from "next";
import { AdminApp } from "../components/AdminApp";

export const metadata: Metadata = { title: "ניהול מאגרי ידע" };

export default function AdminPage() {
  return <AdminApp />;
}
