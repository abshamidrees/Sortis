import { DrawColumn } from "@/components/DrawColumn";
import styles from "./landing.module.css";

/**
 * sortis.xyz -- the landing hero.
 *
 * Section 7 of the brief specifies the full page. This is the hero only: the
 * headline, one brass button, one ghost link, and the draw column running on
 * loop. The remaining five sections are not built yet.
 */
export default function Landing() {
  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <div className={styles.copy}>
          <p className="eyebrow">Confidential prize-linked savings</p>
          <h1 className={styles.headline}>
            Save. Never lose.
            <br />
            Nobody sees.
          </h1>
          <p className={styles.subhead}>
            Your deposit earns a share of the pooled yield as a prize. Your balance, your odds and
            whether you won stay encrypted end to end. The draw itself stays publicly verifiable.
          </p>
          <div className={styles.actions}>
            <a className={styles.primary} href="https://app.sortis.xyz">
              Open the app
            </a>
            <a className={styles.ghost} href="https://docs.sortis.xyz">
              Read the architecture
            </a>
          </div>
        </div>

        <div className={styles.column}>
          <DrawColumn levels={16} loop autoPlay />
          <p className={styles.caption}>
            Sixteen encrypted comparisons resolve one winner from 65,536 stakes. A linear scan over
            the same register reverts at about thirty.
          </p>
        </div>
      </section>
    </main>
  );
}
