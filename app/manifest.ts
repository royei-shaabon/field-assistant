import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

// Lets a technician add the assistant to the phone's home screen and open it like an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRAND.name} · ${BRAND.tagline}`,
    short_name: BRAND.name,
    lang: "he",
    dir: "rtl",
    start_url: "/",
    display: "standalone",
    background_color: BRAND.back,
    theme_color: BRAND.back,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
