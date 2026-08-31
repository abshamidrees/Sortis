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
            <p
              className={styles.standfirst}
              style={{ marginBottom: "var(--s-4)" }}
            >
              Money arrives as public USDT. If wrapping it into confidential
              cUSDT happened in the same transaction as the deposit, the amount
              would be readable one call before it became private, and the
              encryption would buy nothing.
            </p>
            <p className={styles.standfirst}>
              {/*
                Present tense here described a contract that has never run.

                SortisWrapQueue is deployed and has zero logs in its entire
                history: settleEpoch has never executed and nothing has ever
                queued, because the app commits straight to the pool. Describing
                the batching as though it were operating was the worst overclaim
                on the site, and it sat inside the section written to be candid.
                What the queue would buy is still worth stating; what it is
                currently doing is nothing, and that goes first.
              */}
              <strong>
                The queue is deployed and the app does not use it yet.
              </strong>{" "}
              Committing goes straight to the pool, which is the legible path
              for anyone trying this and the less private one: your wrap and
              your stake are one transaction apart and the amount is readable in
              between.
            </p>
            <p
              className={styles.standfirst}
              style={{ marginTop: "var(--s-4)" }}
            >
              What the queue buys, once deposits route through it, is a
              one-to-many link instead of a one-to-one: an epoch closes, the
              whole queue is wrapped and credited together, and a public sender
              maps to any stake settled in that window rather than to one. Four
              hours on Sepolia, longer on mainnet. The limits below apply to
              that design and are the reason it is described here rather than
              claimed as a privacy guarantee.
            </p>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>
                What batching does not fix
              </span>
              <span className={styles.panelVerdict} data-tone="fault">
                honest limits
              </span>
            </div>
            <div className={styles.rows}>
              <div className={styles.row} style={{ alignItems: "flex-start" }}>
                <span
                  className={styles.rowLabel}
                  style={{ color: "var(--ink)", flex: "none" }}
                >
                  Alone in an epoch
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
                  No anonymity set at all. One deposit in, one stake out.
                </span>
              </div>
              <div className={styles.row} style={{ alignItems: "flex-start" }}>
                <span
                  className={styles.rowLabel}
                  style={{ color: "var(--ink)", flex: "none" }}
                >
                  Distinctive amounts
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
                  Amounts are not mixed. Sizes can be matched back.
                </span>
              </div>
              <div className={styles.row} style={{ alignItems: "flex-start" }}>
                <span
                  className={styles.rowLabel}
                  style={{ color: "var(--ink)", flex: "none" }}
                >
                  Settlement order
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
                  Each credit emits an event naming the stake owner.
                </span>
              </div>
            </div>
            <p
              className={styles.provenance}
              style={{ borderTop: "none", marginTop: "var(--s-4)" }}
            >
              Batching raises the cost of linkage. It does not eliminate it.
              Anything stronger needs equal denominations and a real mixer,
              which is a different protocol.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
