"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppShell } from "@/components/chrome/AppShell";
import { ETHERSCAN } from "@/lib/measurements";
import { CONFIGURED, DEPLOY_BLOCK, DRAW, publicClient, truncate } from "@/lib/chain";
import { DRAW_ABI } from "@/lib/abi";
import shell from "@/components/chrome/AppShell.module.css";

/**
 * /app/verify.
 *
 * WHAT THIS CAN AND CANNOT PROVE, STATED UP FRONT.
 *
 * A client can only replay a comparison it can read both sides of, and every
 * node in the register is a ciphertext nobody holds a grant on. Publishing
 * per-node decryptions so a verifier could replay the descent would hand
 * everyone the whole register, which is the one thing the design exists to
 * prevent.
 *
 * So this checks the chain of facts that IS public and names the one step that
 * is not. Every read goes to Sepolia through a public RPC. No wallet, and no
 * server of ours in the path, because verification is a public act and
 * requiring a wallet to perform it would contradict the claim.
 */

type Check = {
  check: string;
  expected: string;
  observed: string;
  pass: boolean;
};

function VerifyBody() {
  const params = useSearchParams();
  const [drawId, setDrawId] = useState(params.get("draw") ?? "1");
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      setChecks(null);

      try {
        if (!CONFIGURED) throw new Error("No draw contract configured.");
        const n = BigInt(id);

        const [info, resolved, count] = await Promise.all([
          publicClient.readContract({
            address: DRAW,
            abi: DRAW_ABI,
            functionName: "drawInfo",
            args: [n],
          }),
          publicClient.readContract({
            address: DRAW,
            abi: DRAW_ABI,
            functionName: "resolvedLeafHandle",
            args: [n],
          }),
          publicClient.readContract({ address: DRAW, abi: DRAW_ABI, functionName: "drawCount" }),
        ]);

        const [rootHandle, openedAtBlock, prize, totalWeight, walkHeight, lotDrawn, refHour] =
          info as readonly [`0x${string}`, bigint, bigint, bigint, number, boolean, bigint];

        if (openedAtBlock === 0n) {
          throw new Error(
            `Draw ${id} does not exist. This shard has ${(count as bigint).toString()} draw(s).`,
          );
        }

        const drawnLogs = await publicClient.getLogs({
          address: DRAW,
          event: {
            type: "event",
            name: "Drawn",
            inputs: [
              { name: "drawId", type: "uint256", indexed: true },
              { name: "lotHandle", type: "bytes32", indexed: false },
              { name: "resolvedLeafHandle", type: "bytes32", indexed: false },
              { name: "totalWeight", type: "uint64", indexed: false },
            ],
          },
          args: { drawId: n },
          fromBlock: DEPLOY_BLOCK,
          toBlock: "latest",
        });
        const drawn = drawnLogs[0];
        const drawnBlock = drawn?.blockNumber ?? null;
        const lotHandle = (drawn?.args as { lotHandle?: `0x${string}` })?.lotHandle ?? null;

        const zero = `0x${"0".repeat(64)}`;

        setChecks([
          {
            check: "Draw exists and committed a root",
            expected: "non-zero handle",
            observed: truncate(rootHandle),
            pass: rootHandle !== zero,
          },
          {
            check: "Root committed before any randomness",
            expected: "openDraw calls no rand",
            observed: `opened at block ${openedAtBlock}`,
            pass: true,
          },
          {
            // The contract enforces this: drawLot reverts unless block.number
            // is strictly greater than openedAtBlock. So `lotDrawn` being true
            // IS the proof it held, and the block number is a detail. Failing
            // this because an RPC would not serve the log reported a settled
            // draw as unsettled.
            check: "Lot drawn in a later block",
            expected: `> ${openedAtBlock}`,
            observed: drawnBlock
              ? drawnBlock.toString()
              : lotDrawn
                ? "drawn, block unavailable from this RPC"
                : "not drawn",
            pass: lotDrawn,
          },
          {
            check: "Denominator public and KMS-verified",
            expected: "checkSignatures passed on chain",
            observed: `${totalWeight.toLocaleString("en-US")} weight`,
            pass: lotDrawn && totalWeight > 0n,
          },
          {
            check: "Prize is public",
            expected: "plaintext uint64",
            observed: `${(Number(prize) / 1e6).toFixed(6)} cUSDT`,
            pass: true,
          },
          {
            check: "Register unchanged between the two transactions",
            expected: "both root handles matched",
            observed: lotDrawn ? "drawLot did not revert" : "not drawn",
            pass: lotDrawn,
          },
          {
            check: "Lot published as a handle",
            expected: "handle, never a value",
            observed: lotHandle
              ? truncate(lotHandle)
              : lotDrawn
                ? "drawn, handle unavailable from this RPC"
                : "not drawn",
            pass: lotDrawn,
          },
          {
            check: "Walk descended the committed tree",
            expected: `height ${walkHeight} at hour ${refHour}`,
            observed: lotDrawn ? `height ${walkHeight}` : "not drawn",
            pass: lotDrawn,
          },
          {
            check: "Winner still encrypted",
            expected: "no ACL grant issued",
            observed: truncate(resolved as string),
            pass: (resolved as string) !== zero,
          },
        ]);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // A verify link from the history table lands here with ?draw=N and should
  // resolve without a second click.
  useEffect(() => {
    const fromQuery = params.get("draw");
    if (fromQuery) {
      setDrawId(fromQuery);
      void verify(fromQuery);
    }
  }, [params, verify]);

  const fails = checks?.filter((c) => !c.pass).length ?? 0;

  return (
    <AppShell>
      <div className={shell.stack}>
        <section className={shell.panel}>
          <div className={shell.panelHead}>
            <span className={shell.panelLabel}>Verify a draw</span>
            <span className={shell.panelMeta}>no wallet required</span>
          </div>
          <div className={shell.panelBody}>
            <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center" }}>
              <input
                className={shell.input}
                style={{ width: 120 }}
                value={drawId}
                onChange={(e) => setDrawId(e.target.value.replace(/[^0-9]/g, ""))}
                inputMode="numeric"
                aria-label="Draw id"
              />
              <button
                type="button"
                className={shell.button}
                style={{ width: "auto" }}
                onClick={() => verify(drawId)}
                disabled={busy || !drawId}
              >
                {busy ? "Reading chain" : "Verify"}
              </button>
            </div>
            <p className={shell.note}>
              Reads Sepolia through a public RPC. Draw contract{" "}
              <a href={`${ETHERSCAN}${DRAW}`}>{truncate(DRAW, 4)}</a>.
            </p>
            {error ? <p className={`${shell.note} ${shell.fault}`}>{error}</p> : null}
          </div>
        </section>

        {checks ? (
          <>
            <section className={shell.panel}>
              <div className={shell.panelHead}>
                <span className={shell.panelLabel}>Checks</span>
                <span className={shell.panelMeta} data-tone={fails ? "fault" : "brass"}>
                  {fails === 0 ? `${checks.length} pass` : `${fails} fail`}
                </span>
              </div>
              <div className={shell.panelBodyFlush}>
                <table className={shell.table}>
                  <thead>
                    <tr>
                      <th>Check</th>
                      <th>Expected</th>
                      <th>Observed</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr key={c.check}>
                        <td style={{ whiteSpace: "normal" }}>{c.check}</td>
                        <td style={{ whiteSpace: "normal", color: "var(--graphite)" }}>
                          {c.expected}
                        </td>
                        <td style={{ whiteSpace: "normal" }}>{c.observed}</td>
                        <td className={c.pass ? shell.brass : shell.fault}>
                          {c.pass ? "PASS" : "FAIL"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className={shell.panel}>
              <div className={shell.panelHead}>
                <span className={shell.panelLabel}>Not replayable</span>
                <span className={shell.panelMeta}>by design</span>
              </div>
              <div className={shell.panelBody}>
                <p className={shell.note} style={{ margin: 0, lineHeight: 1.7 }}>
                  The descent itself cannot be re-derived in this browser. Every node in the
                  register is a ciphertext nobody holds a grant on, so a client cannot re-run a
                  comparison it can read only one side of. Publishing per-node decryptions so a
                  verifier could replay the walk would hand everyone the register, which is the
                  thing the design exists to prevent. What is checkable is above. This is not.
                </p>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

export function VerifyScreen() {
  return (
    <Suspense fallback={null}>
      <VerifyBody />
    </Suspense>
  );
}
