import type { Metadata } from "next";
import { BLEEPBLORP_TITLE } from "@/lib/version";
import "./globals.css";

export const metadata: Metadata = {
  title: BLEEPBLORP_TITLE,
  description:
    "Educational paper trading assistant for Kalshi 15-minute crypto markets. Not financial advice. All trading involves risk.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,500&family=IBM+Plex+Mono:wght@400;500;600&family=Syne:wght@600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
