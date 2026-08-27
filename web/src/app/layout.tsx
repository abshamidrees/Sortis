import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sortis",
  description:
    "Confidential prize-linked savings. You cannot lose your principal, and nobody sees your position.",
};

/**
 * One root layout for all three surfaces. The fonts are the three the brief
 * allows and no fourth: Archivo for display, Inter for body, IBM Plex Mono for
 * every ciphertext handle, address and number.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&family=Inter:wght@400;500&family=IBM+Plex+Mono:wght@400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
