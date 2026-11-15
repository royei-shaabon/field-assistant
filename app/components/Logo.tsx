import { BRAND } from "@/lib/brand";

// The mark: a camera viewfinder with one amber point in it. It is what the product does:
// you point at the machine, and it shows you the spot that matters.
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 64 64" className={className}>
      <rect width="64" height="64" rx="15" fill={BRAND.navy} />
      <path d="M17 27v-6a4 4 0 0 1 4-4h6M37 17h6a4 4 0 0 1 4 4v6M47 37v6a4 4 0 0 1-4 4h-6M27 47h-6a4 4 0 0 1-4-4v-6" fill="none" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" />
      <circle cx="32" cy="32" r="6.5" fill={BRAND.amber} />
    </svg>
  );
}

// Mark and name. `onDark` for the navy bars, where the mark gets a light outline to stay visible.
export function Logo({ size = 32, onDark = false, tagline = false }: { size?: number; onDark?: boolean; tagline?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} className={onDark ? "rounded-[24%] ring-1 ring-white/30" : undefined} />
      <span className="flex flex-col leading-none">
        <span dir="ltr" className={`font-bold tracking-[-0.01em] ${onDark ? "text-white" : "text-ink"}`} style={{ fontSize: Math.round(size * 0.62) }}>
          {BRAND.name}
        </span>
        {tagline && <span className={`pt-1.5 text-[13px] ${onDark ? "text-white/75" : "text-graphite"}`}>{BRAND.tagline}</span>}
      </span>
    </span>
  );
}
