import type { Metadata, Viewport } from "next";
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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Root layout of the app router: the font loads on every page. The rule targets pages/. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap"
        />
      </head>
      <body className="h-full bg-paper">{children}</body>
    </html>
  );
}
