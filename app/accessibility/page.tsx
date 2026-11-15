import type { Metadata } from "next";
import { LegalPage } from "../components/LegalPage";
import { ACCESSIBILITY } from "@/lib/legal-text";

export const metadata: Metadata = { title: ACCESSIBILITY.title };

export default function Page() {
  return <LegalPage doc={ACCESSIBILITY} />;
}
