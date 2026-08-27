import Link from "next/link";

import { Nav } from "@/components/chrome/Nav";
import { DrawColumn } from "@/components/DrawColumn";
import { Reveal } from "@/components/Reveal";
import { Wall } from "@/components/sections/Wall";
import { HowADraw } from "@/components/sections/HowADraw";
import { PrivacyTable } from "@/components/sections/PrivacyTable";
import { WrapLeak } from "@/components/sections/WrapLeak";
import { Footer } from "@/components/sections/Footer";
import { HCU } from "@/lib/measurements";
import styles from "./landing.module.css";

/** One shard, and the tree height that holds it. */
const LEVELS = 5;
const SHARD = 2 ** LEVELS;

/**
 * sortis.xyz
 *
 * Six sections, per section 7 of the brief: hero, the wall, how a draw works,
 * what is private, the wrap leak, footer.
 */
export default function Landing() {
  return (
    <>
      <Nav surface="marketing" />
      <main>
        <section className={styles.heroSection}>
          <div className={styles.hero}>
            <div className={styles.copy}>
              <p className="eyebrow">Confidential prize-linked savings</p>
              <h1 className={styles.headline}>
                Save. Never lose. Nobody sees.
              </h1>
              <p className={styles.subhead}>
                Your deposit earns a share of the pooled yield as a prize. Your balance, your odds
                and whether you won stay encrypted end to end, and the draw itself stays publicly
                verifiable.
              </p>
              <div className={styles.actions}>
                <Link className={styles.primary} href="/app">
                  Open the app
                </Link>
                <a className={styles.ghost} href="#the-wall">
                  Read the architecture
                </a>
              </div>
              <p className={styles.heroStat}>
                {SHARD} stakes per shard. {LEVELS} levels.{" "}
                {HCU.DRAW[3].depth.toLocaleString("en-US")} HCU.
              </p>
            </div>

            <div className={styles.column}>
              <div className={styles.plateHead}>
                <span>REGISTER, SHARD 001</span>
                <span>
                  {SHARD} / {SHARD}
                </span>
              </div>
              <div className={styles.plateBound}>
                <DrawColumn levels={LEVELS} loop autoPlay />
              </div>
              <p className={styles.caption}>
                The lot descends {LEVELS} levels. Every slot stays encrypted.
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
