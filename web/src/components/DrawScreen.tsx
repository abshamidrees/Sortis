import { DrawColumn } from "@/components/DrawColumn";
import { ConnectBar } from "@/components/ConnectBar";
import styles from "@/app/landing.module.css";

/**
 * app.sortis.xyz/draw
 *
 * Section 8 of the brief specifies three screens: Register, Draw and Verify.
 * This is Draw, and only its shell -- the column, wired to nothing yet. The
 * live draw id, committed root, block, pot and countdown come next, along with
 * the other two screens.
 */
export function DrawScreen() {
  return (
    <main className={styles.main}>
      <div className={styles.hero} style={{ alignItems: "start" }}>
        <div className={styles.copy}>
          <ConnectBar />
          <p className="eyebrow" style={{ marginTop: "var(--s-6)" }}>
            Draw
          </p>
          <h1 className={styles.headline} style={{ fontSize: "clamp(2rem, 4vw, 3rem)" }}>
            The register, live.
          </h1>
          <p className={styles.subhead}>
            Every slot is a stake in this shard and shows its ciphertext handle. The lot descends
            one level per beat, halving what is left each time. On resolution one slot turns brass,
            and only the drawn address can decrypt what is in it.
          </p>
        </div>

        <div className={styles.column}>
          <DrawColumn levels={6} showReplay autoPlay />
          <p className={styles.caption}>
            Not yet wired to Sepolia. The column runs a local simulation of the walk.
          </p>
        </div>
      </div>
    </main>
  );
}
