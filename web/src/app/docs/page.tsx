import type { Metadata } from "next";
import Link from "next/link";

import { DOCS } from "@/lib/docs";
import { HCU, LIVE_DRAW } from "@/lib/measurements";
import styles from "./docs.module.css";

export const metadata: Metadata = {
  title: "Documentation | Sortis",
  description:
    "Confidential prize-linked savings on the Zama Protocol. What it is, how the register works, what stays private, and what it does not do.",
};

/**
 * The docs index.
 *
 * A contents page and nothing else. It used to be the contents followed by all
 * four documents inlined beneath it, which meant the index was decoration:
 * every link scrolled you somewhere you had already loaded. Now each entry
 * goes to its own route and this page is short on purpose.
 */
export default function DocsIndex() {
  return (
    <>
      <p className="eyebrow">Documentation</p>
      <h1 className={styles.title}>Sortis</h1>
      <p className={styles.lede}>
        Confidential prize-linked savings on the Zama Protocol. Four pages: what
        it is, how the register works, what stays private, and what it does not
        do.
      </p>

      <nav className={styles.index}>
        {DOCS.map((doc, i) => (
          <Link
            key={doc.slug}
            className={styles.indexRow}
            href={`/docs/${doc.slug}`}
          >
            <span className={styles.indexNumber}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className={styles.indexTitle}>{doc.title}</span>
            <span className={styles.indexBlurb}>{doc.blurb}</span>
          </Link>
        ))}
      </nav>

      {/*
        The two numbers the whole submission rests on, on the page a reader
        lands on first. Both are measured: the mock and the Sepolia
        coprocessor were asked the same question and gave the same answer, and
        at 89.52% of budget that agreement is the reason the shard is 32.
      */}
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.factKey}>Shard capacity</dt>
          <dd className={styles.factValue}>{HCU.SHARD_CEILING} stakes</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factKey}>Draw depth, measured on Sepolia</dt>
          <dd className={styles.factValue}>
            {LIVE_DRAW.depth.toLocaleString("en-US")} of{" "}
            {HCU.DEPTH_LIMIT.toLocaleString("en-US")}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factKey}>Same figure from the mock</dt>
          <dd className={styles.factValue}>
            {LIVE_DRAW.mockDepth.toLocaleString("en-US")}
          </dd>
        </div>
      </dl>
    </>
  );
}
