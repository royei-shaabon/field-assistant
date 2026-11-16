import { BRAND } from "@/lib/brand";

// The mark: an open ring with one square point beside it. A problem not yet closed, and the
// one spot that closes it.
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 100 100" className={className}>
      <rect width="100" height="100" rx="24" fill={BRAND.purple} />
      <path d="M65 25 C45 19 25 33 25 51 C25 70 40 81 57 81 C74 81 84 67 84 53" fill="none" stroke={BRAND.ring} strokeWidth="12" strokeLinecap="round" />
      <rect x="70" y="21" width="15" height="15" rx="4.5" fill={BRAND.dot} transform="rotate(10 77.5 28.5)" />
    </svg>
  );
}

// Mark and name. `onDark` for dark surfaces (the call screen).
export function Logo({ size = 32, onDark = false, tagline = false }: { size?: number; onDark?: boolean; tagline?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="flex flex-col leading-none">
        <span dir="ltr" className={`font-extrabold tracking-[-0.03em] ${onDark ? "text-white" : "text-ink"}`} style={{ fontSize: Math.round(size * 0.6) }}>
          {BRAND.name}
        </span>
        {tagline && <span className={`pt-1.5 text-[13px] ${onDark ? "text-white/75" : "text-stone"}`}>{BRAND.tagline}</span>}
      </span>
    </span>
  );
}
