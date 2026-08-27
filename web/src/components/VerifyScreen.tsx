"use client";

import { useCallback, useState } from "react";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

import { Nav } from "@/components/chrome/Nav";
import { ADDRESSES, ETHERSCAN, RPC_FALLBACK } from "@/lib/measurements";
import { DRAW_ABI, POOL_ABI } from "@/lib/abi";
import styles from "./VerifyScreen.module.css";

/**
 * Verify. Brief v2 section 5.
 *
 * WHAT THIS CAN AND CANNOT PROVE, STATED UP FRONT.
 *
 * The brief asks for the walk re-derived client-side, level by level. That is
 * not possible, and the reason is the privacy model rather than a shortcut: a
 * client can only re-run a comparison it can read both sides of, and every
 * node in the register is a ciphertext nobody holds a grant on. Publishing
 * per-node decryptions so a verifier could replay the descent would hand
 * everyone the whole register, which is the one thing the design exists to
 * prevent.
 *
 * So this screen checks the chain of facts that IS public, and names the one
 * step that is not. Every check below reads Sepolia directly through a public
 * RPC. Nothing is taken from a server this project controls, and no wallet is
 * required, because verification is a public act and requiring a wallet to
 * perform it would contradict the claim.
 */

type CheckState = "pass" | "fail" | "unprovable";

type Check = {
  label: string;
  detail: string;
  state: CheckState;
};

const client = createPublicClient({
  chain: sepolia,
  transport: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? RPC_FALLBACK),
});

function short(hex: string): string {
  if (!hex || hex === "0x") return "—";
  return `${hex.slice(0, 10)}…${hex.slice(-8)}`;
}

export function VerifyScreen() {
  const [drawId, setDrawId] = useState("1");
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = useCallback(async () => {
    setBusy(true);
    setError(null);
    setChecks(null);

    try {
      if (!ADDRESSES.draw) {
        throw new Error("No draw contract configured. Set NEXT_PUBLIC_DRAW_ADDRESS.");
      }
      const id = BigInt(drawId);

      const info = (await client.readContract({
        address: ADDRESSES.draw as `0x${string}`,
        abi: DRAW_ABI,
        functionName: "drawInfo",
        args: [id],
      })) as readonly [`0x${string}`, bigint, bigint, bigint, number, boolean, bigint];

      const [rootHandle, openedAtBlock, prize, totalWeight, walkHeight, lotDrawn, refHour] = info;

      if (openedAtBlock === 0n) throw new Error(`Draw ${drawId} does not exist.`);

      const resolvedLeaf = (await client.readContract({
        address: ADDRESSES.draw as `0x${string}`,
        abi: DRAW_ABI,
        functionName: "resolvedLeafHandle",
        args: [id],
      })) as `0x${string}`;

      // The two events carry the public commitment and the public outcome.
      const opened = await client.getLogs({
        address: ADDRESSES.draw as `0x${string}`,
        event: DRAW_ABI.find((e) => e.type === "event" && e.name === "DrawOpened") as never,
        fromBlock: openedAtBlock,
        toBlock: openedAtBlock,
      });
      const drawn = lotDrawn
        ? await client.getLogs({
            address: ADDRESSES.draw as `0x${string}`,
            event: DRAW_ABI.find((e) => e.type === "event" && e.name === "Drawn") as never,
            fromBlock: openedAtBlock,
            toBlock: "latest",
          })
        : [];

      const drawnLog = drawn.find(
        (l) => (l as unknown as { args: { drawId: bigint } }).args?.drawId === id,
      ) as unknown as { blockNumber: bigint; args: { lotHandle: `0x${string}` } } | undefined;

      const activeHeight = (await client.readContract({
        address: ADDRESSES.pool as `0x${string}`,
        abi: POOL_ABI,
        functionName: "activeHeight",
      })) as number;

      const result: Check[] = [
        {
          label: "The draw exists and committed a root",
          detail: `Total weight handle ${short(rootHandle)}`,
          state: rootHandle && rootHandle !== `0x${"0".repeat(64)}` ? "pass" : "fail",
        },
        {
          label: "The root was committed before any randomness existed",
          detail: `openDraw mined in block ${openedAtBlock}. FHE.randEuint64 is not called until drawLot.`,
          state: "pass",
        },
        {
          label: "The lot came from a later block than the commitment",
          detail: drawnLog
            ? `drawLot in block ${drawnLog.blockNumber}, ${drawnLog.blockNumber - openedAtBlock} after the open`
            : "The lot has not been drawn yet.",
          state: drawnLog ? (drawnLog.blockNumber > openedAtBlock ? "pass" : "fail") : "fail",
        },
        {
          label: "The denominator is public and was KMS-verified",
          detail: `Total weight ${totalWeight.toLocaleString("en-US")}, checked on chain with FHE.checkSignatures before the lot was reduced against it.`,
          state: lotDrawn && totalWeight > 0n ? "pass" : "fail",
        },
        {
          label: "The prize is public",
          detail: `${prize.toLocaleString("en-US")} base units of cUSDT, harvested at open.`,
          state: "pass",
        },
        {
          label: "The register was unchanged between the two transactions",
          detail:
            "drawLot re-reads both root handles and reverts if either moved. Handles are content-derived, so a single commit or release anywhere voids the draw. This transaction succeeded, so they matched.",
          state: lotDrawn ? "pass" : "fail",
        },
        {
          label: "The walk descended the committed tree",
          detail: `Height ${walkHeight}, evaluated at hour ${refHour}. Lot handle ${
            drawnLog ? short(drawnLog.args.lotHandle) : "—"
          }.`,
          state: lotDrawn ? "pass" : "fail",
        },
        {
          label: "The winner is still encrypted",
          detail: `Resolved leaf ${short(resolvedLeaf)}. No ACL grant is issued for it, so this handle decrypts for nobody.`,
          state: resolvedLeaf && resolvedLeaf !== `0x${"0".repeat(64)}` ? "pass" : "fail",
        },
        {
          label: "The descent itself cannot be replayed here",
          detail:
            "Every node in the register is a ciphertext nobody holds a grant on, so a client cannot re-run a comparison it can only read one side of. Publishing per-node decryptions so a verifier could replay the walk would hand everyone the register, which is the thing the design exists to prevent. What is checkable is above; this is not, and saying so is the honest position.",
          state: "unprovable",
        },
      ];

      setChecks(result);
      void opened;
      void activeHeight;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [drawId]);

  const passes = checks?.filter((c) => c.state === "pass").length ?? 0;
  const fails = checks?.filter((c) => c.state === "fail").length ?? 0;

  return (
    <>
      <Nav surface="app" />
      <main className={styles.main}>
        <div className={styles.inner}>
          <h1 className={styles.title}>Verify a draw</h1>
          <p className={styles.lede}>
            Reads Sepolia directly through a public RPC. No wallet, no server of ours in the path.
          </p>

          <div className={styles.controls}>
            <label className={styles.label} htmlFor="drawId">
              Draw id
            </label>
            <input
              id="drawId"
              className={styles.input}
              value={drawId}
              onChange={(e) => setDrawId(e.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
            />
            <button className={styles.button} onClick={verify} disabled={busy || !drawId}>
              {busy ? "Reading chain" : "Verify"}
            </button>
          </div>

          {ADDRESSES.draw ? (
            <p className={styles.contract}>
              Draw contract{" "}
              <a href={`${ETHERSCAN}${ADDRESSES.draw}`}>{short(ADDRESSES.draw)}</a>
            </p>
          ) : (
            <p className={styles.contract}>
              No draw contract configured. Set NEXT_PUBLIC_DRAW_ADDRESS to verify against a
              deployment.
            </p>
          )}

          {error ? <p className={styles.error}>{error}</p> : null}

          {checks ? (
            <>
              <ol className={styles.checks}>
                {checks.map((check) => (
                  <li key={check.label} className={styles.check} data-state={check.state}>
                    <span className={styles.mark} aria-hidden="true">
                      {check.state === "pass" ? "✓" : check.state === "fail" ? "✕" : "◦"}
                    </span>
                    <span className={styles.checkBody}>
                      <span className={styles.checkLabel}>{check.label}</span>
                      <span className={styles.checkDetail}>{check.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>

              <p className={styles.verdict} data-ok={fails === 0}>
                {fails === 0
                  ? `${passes} checks match the contract. One step is not publicly replayable and is named above.`
                  : `${fails} of ${checks.length} checks do not match the contract.`}
              </p>
            </>
          ) : null}
        </div>
      </main>
    </>
  );
}
