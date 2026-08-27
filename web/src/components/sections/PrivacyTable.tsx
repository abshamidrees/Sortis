import styles from "./section.module.css";

/**
 * Section 4. What stays private and what does not.
 *
 * A plain two-column table, and the public column is the point. A privacy
 * product that will not name what it leaks is asking to be taken on trust,
 * and the honest column is what makes the private one believable.
 *
 * Colour carries the meaning here, per the semantic rule in section 5 of the
 * brief: seal is encrypted, graphite is public and unremarkable.
 */

const PRIVATE = [
  { what: "Your deposit", how: "euint64, encrypted in your wallet before it is sent" },
  { what: "Your balance", how: "euint64, decryptable by you and nobody else" },
  { what: "Your weight", how: "euint64, the time-weighted stake the draw reads" },
  { what: "Whether you won", how: "The resolved leaf is an encrypted index" },
  { what: "What you were paid", how: "A losing claim transfers an encrypted zero" },
];

const PUBLIC = [
  { what: "The pot size", how: "Harvested yield, plaintext, so the draw can be checked" },
  { what: "The tree root", how: "A handle, published when the draw opens" },
  { what: "The block", how: "The lot must come from a later one" },
  { what: "That a draw happened", how: "Anyone can verify the walk ran against that root" },
  { what: "That you interacted", how: "Your address, the time, and the direction" },
];

export function PrivacyTable() {
  return (
    <section className={styles.section} id="what-is-private">
      <div className={styles.inner}>
        <div className={styles.head}>
          <span className={styles.number}>04</span>
          <p className="eyebrow">The threat model</p>
          <h2 className={styles.title}>What stays private, and what does not.</h2>
          <p className={styles.standfirst}>
            The right-hand column is deliberate. Public verifiability is the point of the design,
            and a draw nobody can check is not worth having.
          </p>
        </div>

        <div className={styles.pair}>
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Private</span>
              <span className={styles.panelVerdict} style={{ color: "var(--seal)" }}>
                encrypted
              </span>
            </div>
            <div className={styles.rows}>
              {PRIVATE.map((row) => (
                <div key={row.what} className={styles.row} style={{ alignItems: "flex-start" }}>
                  <span className={styles.rowLabel} style={{ color: "var(--ink)", flex: "none" }}>
                    {row.what}
                  </span>
                  <span
                    className={styles.rowValue}
                    data-tone="seal"
                    style={{ whiteSpace: "normal", textAlign: "right", fontSize: "0.75rem" }}
                  >
                    {row.how}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Public</span>
              <span className={styles.panelVerdict} style={{ color: "var(--graphite)" }}>
                on chain
              </span>
            </div>
            <div className={styles.rows}>
              {PUBLIC.map((row) => (
                <div key={row.what} className={styles.row} style={{ alignItems: "flex-start" }}>
                  <span className={styles.rowLabel} style={{ color: "var(--ink)", flex: "none" }}>
                    {row.what}
                  </span>
                  <span
                    className={styles.rowValue}
                    style={{
                      whiteSpace: "normal",
                      textAlign: "right",
                      fontSize: "0.75rem",
                      color: "var(--graphite)",
                    }}
                  >
                    {row.how}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
