import type { Metadata, Viewport } from "next";
// Fonts are served from this site (no request to a font service): Hebrew and Latin, three weights.
import "@fontsource/ibm-plex-sans-hebrew/hebrew-400.css";
import "@fontsource/ibm-plex-sans-hebrew/hebrew-500.css";
import "@fontsource/ibm-plex-sans-hebrew/hebrew-600.css";
import "@fontsource/ibm-plex-sans-hebrew/latin-400.css";
import "@fontsource/ibm-plex-sans-hebrew/latin-500.css";
import "@fontsource/ibm-plex-sans-hebrew/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "עוזר תקלות לטכנאי",
  description: "עוזר שטח לטכנאים: עונה רק מהמסמכים שבמאגר הידע, עם המקור",
};

// interactiveWidget: the layout shrinks when the on-screen keyboard opens, so the question box
// stays in view. Zoom is left to the user.
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff", interactiveWidget: "resizes-content" };

// The disclaimer line is rendered by each screen (app/components/TechnicianApp.tsx).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="he" dir="rtl" className="h-full antialiased">
      <body className="h-full bg-paper">{children}</body>
    </html>
  );
}
