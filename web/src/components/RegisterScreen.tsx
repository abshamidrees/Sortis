"use client";

import { useAccount } from "wagmi";

import { Nav } from "@/components/chrome/Nav";
import { HCU } from "@/lib/measurements";
import styles from "./VerifyScreen.module.css";

/**
 * Register. Brief v2 section 5.
 *
 * Only the disconnected state is built. That state is the whole screen until a
 * wallet arrives, and the spec describes it exactly: one centred panel, one
 * connect button, one line saying what happens next.
 *
 * The connected half needs the relayer wired into the browser, which is a
 * different piece of work: `initializeCLIApi` pulls a 4.6MB CRS and takes
 * about twenty minutes on a cold machine and twenty-seven seconds once it is
 * cached. Shipping a connected state that hangs for twenty minutes behind an
 * unexplained spinner would be worse than shipping this and saying so.
 */
export function RegisterScreen() {
  const { isConnected, address } = useAccount();

  return (
    <>
      <Nav surface="app" />
      <main className={styles.main}>
        <div className={styles.inner}>
          <h1 className={styles.title}>Your stake</h1>

          {isConnected ? (
            <>
              <p className={styles.lede}>
                Connected as <code>{address}</code>.
              </p>
              <p className={styles.error}>
                The commit and release forms are not wired up yet. Use{" "}
                <code>npm run live:sepolia</code> at the repo root to run a full cycle against this
                shard from the command line. What is missing here is the browser side of the
                relayer, not the contracts.
              </p>
            </>
          ) : (
            <>
              <p className={styles.lede}>
                Connect a wallet to see what you hold. Your balance is a ciphertext on chain and is
                decrypted in your browser, for your session only. Nothing is sent anywhere.
              </p>
              <p className={styles.contract}>
                commit() {HCU.COMMIT_DEPTH.toLocaleString("en-US")} HCU. One shard holds{" "}
                {HCU.SHARD_CEILING} stakes.
              </p>
            </>
          )}
        </div>
      </main>
    </>
  );
}
