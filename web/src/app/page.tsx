import { DrawColumn } from "@/components/DrawColumn";
import { Reveal } from "@/components/Reveal";
import { Wall } from "@/components/sections/Wall";
import { HowADraw } from "@/components/sections/HowADraw";
import { PrivacyTable } from "@/components/sections/PrivacyTable";
import { WrapLeak } from "@/components/sections/WrapLeak";
import { Footer } from "@/components/sections/Footer";
import styles from "./landing.module.css";

/**
 * sortis.xyz
 *
 * Six sections, per section 7 of the brief: hero, the wall, how a draw works,
 * what is private, the wrap leak, footer.
 */
export default function Landing() {
  return (
    <>
      <main>
        <section className={styles.heroSection}>
          <div className={styles.hero}>
            <div className={styles.copy}>
              <p className="eyebrow">Confidential prize-linked savings</p>
              <h1 className={styles.headline}>
                Save. Never lose.
                <br />
                Nobody sees.
              </h1>
              <p className={styles.subhead}>
                Your deposit earns a share of the pooled yield as a prize. Your balance, your odds
                and whether you won stay encrypted end to end, and the draw itself stays publicly
                verifiable.
              </p>
              <div className={styles.actions}>
                <a className={styles.primary} href="https://app.sortis.xyz">
                  Open the app
                </a>
                <a className={styles.ghost} href="#the-wall">
                  Read the architecture
                </a>
              </div>
            </div>

            <div className={styles.column}>
              <DrawColumn levels={16} loop autoPlay />
              <p className={styles.caption}>
                Sixteen encrypted comparisons resolve one winner from 65,536 stakes. A linear scan
                over the same register reverts at thirty.
              </p>
            </div>
          </div>
        </section>

        <Reveal>
          <Wall />
        </Reveal>
        <Reveal>
          <HowADraw />
        </Reveal>
        <Reveal>
          <PrivacyTable />
        </Reveal>
        <Reveal>
          <WrapLeak />
        </Reveal>
      </main>
      <Footer />
    </>
  );
}
