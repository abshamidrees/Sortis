import styles from "./section.module.css";
import { HCU } from "@/lib/measurements";

/**
 * Section 3. How a draw works.
 *
 * Numbered markers, because the order is real and load-bearing: the root is
 * committed before the randomness exists, and reversing those two steps would
 * let an operator see the lot and reshape the tree before broadcasting.
 */

const STEPS = [
  {
    title: "Commit",
    body: "Money enters as confidential cUSDT. Weight accrues from how much sat in the pool and for how long, so a deposit made a moment before a draw carries nothing.",
    meta: `commit()  ${HCU.COMMIT_DEPTH.toLocaleString("en-US")} HCU`,
  },
  {
    title: "The root is snapshotted",
    body: "Opening a draw publishes the register root and the block. No randomness exists yet, anywhere, so the operator has to commit to the tree before learning anything about who it favours.",
    meta: "openDraw()  no randomness yet",
  },
  {
    title: "The lot is drawn",
    body: "In a later block, the chain itself produces the lot with FHE.randEuint64. No oracle and no VRF. If the register moved since the snapshot, the root handle changed and the draw is void.",
    meta: "drawLot()  one block later",
  },
  {
    title: "One slot resolves",
    body: "The walk descends the shard, one encrypted comparison per level, halving what is left each time. It lands on a leaf and the index stays encrypted. Only the drawn address can decrypt what it holds.",
    meta: `${HCU.SHARD_CEILING} stakes, ${HCU.WALK[4].depth.toLocaleString("en-US")} HCU`,
  },
];

export function HowADraw() {
  return (
    <section className={styles.section} id="how-a-draw-works">
      <div className={styles.inner}>
        <div className={styles.head}>
          <span className={styles.number}>03</span>
          <p className="eyebrow">The sequence</p>
          <h2 className={styles.title}>How a draw works.</h2>
          <p className={styles.standfirst}>
            Four steps, in this order. The gap between the second and the third is the security
            argument, not an implementation detail.
          </p>
        </div>

        <ol className={styles.steps} style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {STEPS.map((step, i) => (
            <li key={step.title} className={styles.step} data-current={i === 3}>
              <span className={styles.stepNumber}>{String(i + 1).padStart(2, "0")}</span>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepBody}>{step.body}</p>
              <span className={styles.stepMeta}>{step.meta}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
