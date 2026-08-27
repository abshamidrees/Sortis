"use client";

import type { ReactNode } from "react";

import { Nav } from "./Nav";
import { StatStrip } from "./StatStrip";
import styles from "./AppShell.module.css";

/**
 * The chrome every app route sits inside: nav, stat strip, then the route.
 *
 * One component so the strip cannot drift between routes and so a route never
 * forgets it. The strip is the thing that makes /app read as software rather
 * than as a marketing page in application clothing.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav surface="app" />
      <StatStrip />
      <main className={styles.main}>{children}</main>
    </>
  );
}
