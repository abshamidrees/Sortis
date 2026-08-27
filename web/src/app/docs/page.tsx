import styles from "../landing.module.css";

/**
 * docs.sortis.xyz
 *
 * Section 9 specifies six Fumadocs pages. This is a placeholder so the third
 * hostname resolves and the middleware can be verified end to end; Fumadocs is
 * not wired up yet.
 */
export default function Docs() {
  return (
    <main className={styles.main}>
      <div className={styles.hero}>
        <div className={styles.copy}>
          <p className="eyebrow">Documentation</p>
          <h1 className={styles.headline} style={{ fontSize: "clamp(2rem, 4vw, 3rem)" }}>
            Architecture
          </h1>
          <p className={styles.subhead}>
            Six pages planned: overview, architecture, privacy model, contracts, verify a draw, and
            limitations. Not yet written. The contract source carries the HCU accounting inline in
            the meantime.
          </p>
        </div>
      </div>
    </main>
  );
}
