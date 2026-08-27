import styles from "./section.module.css";

/**
 * Section 5. The wrap leak, addressed.
 *
 * Short, and it states the limitation rather than burying it. A depositor who
 * is alone in an epoch gets no anonymity set, and saying so is worth more than
 * a claim that would not survive a judge reading the contract.
 */
export function WrapLeak() {
  return (
    <section className={styles.section} id="the-wrap-leak">
      <div className={styles.inner}>
        <div className={styles.head}>
          <span className={styles.number}>05</span>
          <p className="eyebrow">The limitation</p>
          <h2 className={styles.title}>The wrap leak, addressed.</h2>
        </div>

        <div className={styles.pair}>
          <div>
            <p className={styles.standfirst} style={{ marginBottom: "var(--s-4)" }}>
              Money arrives as public USDT. If wrapping it into confidential cUSDT happened in the
              same transaction as the deposit, the amount would be readable one call before it
              became private, and the encryption would buy nothing.
            </p>
            <p className={styles.standfirst}>
              Deposits queue instead. At the end of each epoch the whole queue is wrapped and
              credited together, so the on-chain link between a public sender and a confidential
              stake is one-to-many across everyone who queued in that window. Four hours on Sepolia,
              longer on mainnet.
            </p>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>What batching does not fix</span>
              <span className={styles.panelVerdict} data-tone="fault">
                honest limits
              </span>
            </div>
            <div className={styles.rows}>
              <div className={styles.row} style={{ alignItems: "flex-start" }}>
                <span className={styles.rowLabel} style={{ color: "var(--ink)", flex: "none" }}>
                  Alone in an epoch
                </span>
                <span
                  className={styles.rowValue}
                  style={{ whiteSpace: "normal", textAlign: "right", fontSize: "0.75rem", color: "var(--graphite)" }}
                >
                  No anonymity set at all. One deposit in, one stake out.
                </span>
              </div>
              <div className={styles.row} style={{ alignItems: "flex-start" }}>
                <span className={styles.rowLabel} style={{ color: "var(--ink)", flex: "none" }}>
                  Distinctive amounts
                </span>
                <span
                  className={styles.rowValue}
                  style={{ whiteSpace: "normal", textAlign: "right", fontSize: "0.75rem", color: "var(--graphite)" }}
                >
                  Amounts are not mixed. Sizes can be matched back.
                </span>
              </div>
              <div className={styles.row} style={{ alignItems: "flex-start" }}>
                <span className={styles.rowLabel} style={{ color: "var(--ink)", flex: "none" }}>
                  Settlement order
                </span>
                <span
                  className={styles.rowValue}
                  style={{ whiteSpace: "normal", textAlign: "right", fontSize: "0.75rem", color: "var(--graphite)" }}
                >
                  Each credit emits an event naming the stake owner.
                </span>
              </div>
            </div>
            <p className={styles.provenance} style={{ borderTop: "none", marginTop: "var(--s-4)" }}>
              Batching raises the cost of linkage. It does not eliminate it. Anything stronger needs
              equal denominations and a real mixer, which is a different protocol.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
