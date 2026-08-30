import type { ReactNode } from "react";

import { Nav } from "@/components/chrome/Nav";
import { DocsRail } from "@/components/docs/DocsRail";
import styles from "./docs.module.css";

/**
 * The docs shell.
 *
 * Four routes now, not four anchors on one page. The content was always
 * written; it lived as `#privacy-model` on a single scroll, which meant the
 * rail could not show where you were, a link to one page dropped you at the
 * top of all four, and the browser's back button had nothing to go back to.
 *
 * The nav and the rail live here so a page file is nothing but its own prose.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav surface="marketing" />
      <main className={styles.main}>
        <div className={styles.shell}>
          <DocsRail />
          <div className={styles.inner}>{children}</div>
        </div>
      </main>
    </>
  );
}
