import Link from "next/link";
import { LEGAL_LINKS, type LegalDoc } from "@/lib/legal-text";

// A plain reading page: one column, real headings and lists.
export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 pb-12 pt-6">
      <nav aria-label="ניווט" className="pb-6">
        <Link href="/" className="text-[15px] font-medium underline underline-offset-4">
          חזרה לעוזר
        </Link>
      </nav>
      <main>
        <h1 className="text-[28px] font-semibold leading-9">{doc.title}</h1>
        <p className="pt-3 text-base leading-7 text-graphite">{doc.intro}</p>
        {doc.sections.map((s) => (
          <section key={s.heading} className="pt-7">
            <h2 className="text-xl font-semibold leading-7">{s.heading}</h2>
            <ul className="flex list-disc flex-col gap-2 ps-5 pt-2.5 text-base leading-7">
              {s.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </main>
      <footer className="flex gap-5 pt-10 text-[15px]">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="underline underline-offset-4">
            {l.label}
          </Link>
        ))}
      </footer>
    </div>
  );
}
