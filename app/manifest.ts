import type { MetadataRoute } from "next";

// Lets a technician add the assistant to the phone's home screen and open it like an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "עוזר תקלות לטכנאי",
    short_name: "עוזר תקלות",
    lang: "he",
    dir: "rtl",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#121212",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
