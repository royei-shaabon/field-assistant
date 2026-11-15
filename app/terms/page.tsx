import type { Metadata } from "next";
import { LegalPage } from "../components/LegalPage";
import { TERMS } from "@/lib/legal-text";

export const metadata: Metadata = { title: TERMS.title };

export default function Page() {
  return <LegalPage doc={TERMS} />;
}
