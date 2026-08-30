"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { DOCS } from "@/lib/docs";
import { REPO_URL } from "@/lib/measurements";
import styles from "@/app/docs/docs.module.css";

/**
 * The persistent left rail.
 *
 * Structure from Aave Pro, which is dark; this is stone and brass and shares
 * nothing with it but the shape: grouped links under uppercase headings, with
 * the content beside them rather than under them. Scoped to the docs and kept
 * away from the app, where a rail would compete with the stat strip.
 *
 * A client component only because it needs `usePathname` to mark the page you
 * are on. That was the point of splitting the docs into routes: on one scroll
 * there was no current page for a rail to indicate.
 */
export function DocsRail() {
  const pathname = usePathname();

  return (
    <aside className={styles.rail}>
      <div className={styles.railGroup}>
        <span className={styles.railLabel}>Documentation</span>
        {DOCS.map((doc) => {
          const href = `/docs/${doc.slug}`;
          return (
            <Link
              key={doc.slug}
              className={styles.railLink}
              href={href}
              data-active={pathname === href || undefined}
              aria-current={pathname === href ? "page" : undefined}
            >
              {doc.title}
            </Link>
          );
        })}
      </div>

      <div className={styles.railGroup}>
        <span className={styles.railLabel}>Product</span>
        <Link className={styles.railLink} href="/app">
          Open the app
        </Link>
        <Link className={styles.railLink} href="/app/verify">
          Verify a draw
        </Link>
      </div>

      <div className={styles.railGroup}>
        <span className={styles.railLabel}>Source</span>
        <a className={styles.railLink} href={REPO_URL}>
          Repository
        </a>
        <a
          className={styles.railLink}
          href={`${REPO_URL}/blob/main/test/HCU.t.ts`}
        >
          HCU measurements
        </a>
      </div>
    </aside>
  );
}
