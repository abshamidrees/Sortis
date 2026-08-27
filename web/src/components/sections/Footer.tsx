import styles from "./section.module.css";
import { ADDRESSES, ETHERSCAN, REPO_URL } from "@/lib/measurements";

/**
 * Section 6. Footer. Repo, docs, Sepolia addresses, the Zama tag.
 *
 * No legal section and no lawyer, per the brief. Addresses come from the
 * environment and render as "Not deployed" when unset, because a plausible
 * looking address that resolves to nothing is exactly the placeholder data the
 * craft standard forbids.
 */

const CONTRACTS = [
  { label: "SortisPool", address: ADDRESSES.pool },
  { label: "SortisDraw", address: ADDRESSES.draw },
  { label: "cUSDT", address: ADDRESSES.cUSDT },
];

function Address({ label, address }: { label: string; address: string }) {
  return (
    <li className={styles.footerAddress}>
      <span className={styles.footerAddressLabel}>{label}</span>
      {address ? (
        <a
          href={`${ETHERSCAN}${address}`}
          style={{ fontFamily: "var(--font-data)", fontSize: "0.75rem", color: "var(--seal)" }}
        >
          {`${address.slice(0, 6)}…${address.slice(-4)}`}
        </a>
      ) : (
        <span
          style={{ fontFamily: "var(--font-data)", fontSize: "0.75rem", color: "var(--graphite)" }}
        >
          Not deployed
        </span>
      )}
    </li>
  );
}

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerGrid}>
        <div>
          <h2 className={styles.footerHeading}>Sortis</h2>
          <p className={styles.footerNote}>
            Confidential prize-linked savings on the Zama Protocol. Latin <i>sors, sortis</i>, the
            lot cast to decide a matter.
          </p>
        </div>

        <div>
          <h2 className={styles.footerHeading}>Project</h2>
          <ul className={styles.footerList}>
            <li>
              <a href={REPO_URL}>Repository</a>
            </li>
            <li>
              <a href="https://docs.sortis.xyz">Documentation</a>
            </li>
            <li>
              <a href="https://app.sortis.xyz">Open the app</a>
            </li>
          </ul>
        </div>

        <div>
          <h2 className={styles.footerHeading}>Sepolia</h2>
          <ul className={styles.footerList}>
            {CONTRACTS.map((contract) => (
              <Address key={contract.label} {...contract} />
            ))}
          </ul>
        </div>
      </div>

      <p className={styles.footerTag}>
        Zama Developer Program, Mainnet Season 4. Sepolia only. The yield source on Sepolia is a
        mock with an admin-callable accrue, and the register has not been audited.
      </p>
    </footer>
  );
}
