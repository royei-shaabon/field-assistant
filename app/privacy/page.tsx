import type { Metadata } from "next";
import { LegalPage } from "../components/LegalPage";
import { PRIVACY } from "@/lib/legal-text";

export const metadata: Metadata = { title: PRIVACY.title };

export default function Page() {
  return <LegalPage doc={PRIVACY} />;
}
