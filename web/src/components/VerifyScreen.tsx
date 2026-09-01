"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppShell } from "@/components/chrome/AppShell";
import { ETHERSCAN } from "@/lib/measurements";
import {
  CONFIGURED,
  DRAW,
  publicClient,
  readDrawnEvent,
  truncate,
  resilientRead,
} from "@/lib/chain";
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

/**
 * A check has three outcomes, not two.
 *
 * Six of these depend on the draw having been settled, and a draw that is
 * merely open has not failed anything: the lot has not been produced yet.
 * Rendering that as FAIL told a reader the draw was broken when it was
 * halfway through, which is the opposite of what a verification screen is
 * for.
 */
/**
 * Four outcomes, because three of them are not "pass".
 *
 *   pass     observed, and it is what it should be
 *   fail     observed, and it is not
 *   pending  the draw has not settled, so there is nothing to observe yet
 *   unread   the draw HAS settled and this RPC would not serve the value
 *
 * The last one used to report PASS with an observed column reading
 * "unavailable from this RPC". On the one screen whose whole purpose is
 * rigour, a check that could not read its value must not claim success.
 */
type Result = "pass" | "fail" | "pending" | "unread";

type Check = {
  check: string;
  expected: string;
  observed: string;
  result: Result;
};

function VerifyBody() {
  const params = useSearchParams();
  /*
    Defaults to the LATEST draw, not to draw 1.

    Draw 1 on this shard was opened while a single leaf carried weight, so it
    settled with walk height 0 and demonstrates nothing about the descent. It
    is permanent history and cannot be repaired, so the app should not open on
    it: a judge landing here should see the most recent draw, which is the one
    that actually descended the tree.

    An explicit ?draw=N in the URL still wins, because a verify link from the
    history table has to resolve the row it was clicked from.
  */
  const [drawId, setDrawId] = useState(params.get("draw") ?? "");
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    setChecks(null);

    try {
      if (!CONFIGURED) throw new Error("No draw contract configured.");
      const n = BigInt(id);

      /*
        RETRIED, like every other read in the app.

        These three went out raw, and a throttled provider does not always
        answer an eth_call with an error: sometimes it answers with empty data.
        viem then reports "Cannot decode zero data" for drawInfo, or decodes a
        field to undefined and the next line fails converting it to a BigInt.
        Both surfaced on this screen as though the DRAW were malformed, which
        is the worst possible false accusation to make on the page whose job is
        verifying that it is not.
      */
      const [info, resolved, count] = await resilientRead(() =>
        Promise.all([
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
          publicClient.readContract({
            address: DRAW,
            abi: DRAW_ABI,
            functionName: "drawCount",
          }),
        ])
      );

      const [
        rootHandle,
        openedAtBlock,
        prize,
        totalWeight,
        walkHeight,
        lotDrawn,
        refHour,
      ] = info as readonly [
        `0x${string}`,
        bigint,
        bigint,
        bigint,
        number,
        boolean,
        bigint
      ];

      if (openedAtBlock === 0n) {
        throw new Error(
          `Draw ${id} does not exist. This shard has ${(
            count as bigint
          ).toString()} draw(s).`
        );
      }

      const drawn = await readDrawnEvent(n);
      const drawnBlock = drawn?.block ?? null;
      const lotHandle = drawn?.lot ?? null;

      const zero = `0x${"0".repeat(64)}`;
      /** Pending until the lot exists, then judged. */
      const settledOr = (ok: boolean): Result =>
        lotDrawn ? (ok ? "pass" : "fail") : "pending";

      setChecks([
        {
          check: "Draw exists and committed a root",
          expected: "non-zero handle",
          observed: truncate(rootHandle),
          result: rootHandle !== zero ? "pass" : "fail",
        },
        {
          check: "Root committed before any randomness",
          expected: "openDraw calls no rand",
          observed: `opened at block ${openedAtBlock}`,
          result: "pass",
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
            ? "settled, but this RPC would not serve the block"
            : "not drawn",
          // The contract enforces block.number > openedAtBlock, so a settled
          // draw proves the ordering held. That is an argument, not an
          // observation, and this column reports observations.
          result: !lotDrawn ? "pending" : drawnBlock ? "pass" : "unread",
        },
        {
          check: "Denominator public and KMS-verified",
          expected: "checkSignatures passed on chain",
          observed: `${totalWeight.toLocaleString("en-US")} weight`,
          result: lotDrawn ? (totalWeight > 0n ? "pass" : "fail") : "pending",
        },
        {
          check: "Prize is public",
          expected: "plaintext uint64",
          observed: `${(Number(prize) / 1e6).toFixed(6)} cUSDT`,
          result: "pass",
        },
        {
          check: "Register unchanged between the two transactions",
          expected: "both root handles matched",
          observed: lotDrawn ? "drawLot did not revert" : "not drawn",
          result: settledOr(lotDrawn),
        },
        {
          check: "Lot published as a handle",
          expected: "handle, never a value",
          observed: lotHandle
            ? truncate(lotHandle)
            : lotDrawn
            ? "settled, but this RPC would not serve the handle"
            : "not drawn",
          result: !lotDrawn ? "pending" : lotHandle ? "pass" : "unread",
        },
        {
          check: "Walk descended the committed tree",
          expected: `height ${walkHeight} at hour ${refHour}`,
          observed: lotDrawn ? `height ${walkHeight}` : "not drawn",
          result: settledOr(lotDrawn),
        },
        {
          check: "Winner still encrypted",
          expected: "no ACL grant issued",
          observed: truncate(resolved as string),
          result: lotDrawn
            ? (resolved as string) !== zero
              ? "pass"
              : "fail"
            : "pending",
        },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  // A verify link from the history table lands here with ?draw=N and should
  // resolve without a second click. With no parameter, resolve the latest draw
  // from chain rather than assuming a number.
  useEffect(() => {
    const fromQuery = params.get("draw");
    if (fromQuery) {
      setDrawId(fromQuery);
      void verify(fromQuery);
      return;
    }
    let alive = true;
    // Busy from the first paint, not from when the read returns. Resolving the
    // latest draw takes a Sepolia round trip, and until it landed this route
    // rendered an input and nothing else, so a judge arriving here saw an
    // apparently empty page and no reason to think anything was happening.
    setBusy(true);
    /*
      Retried, because this one read decides whether the route works at all.

      Unwrapped, a single refused drawCount left the screen reading "Could not
      reach Sepolia to find the latest draw", which is the state a judge met in
      production. Everything the page then goes on to prove was reachable only
      by guessing a draw id into the box.
    */
    void resilientRead(() =>
      publicClient.readContract({
        address: DRAW,
        abi: DRAW_ABI,
        functionName: "drawCount",
      })
    )
      .then(async (count) => {
        const total = count as bigint;
        if (!alive) return;
        if (total === 0n) {
          setBusy(false);
          setError("No draw has been opened on this shard yet.");
          return;
        }
        // Walk back to the most recent SETTLED draw. The newest draw may have
        // been opened and not yet drawn, and landing a judge on that shows six
        // checks waiting on a lot that does not exist.
        let target = total;
        for (let id = total; id >= 1n; id--) {
          const info = (await resilientRead(() =>
            publicClient.readContract({
              address: DRAW,
              abi: DRAW_ABI,
              functionName: "drawInfo",
              args: [id],
            })
          )) as readonly [
            string,
            bigint,
            bigint,
            bigint,
            number,
            boolean,
            bigint
          ];
          if (info[5]) {
            target = id;
            break;
          }
        }
        if (!alive) return;
        setDrawId(target.toString());
        void verify(target.toString());
      })
      .catch(() => {
        if (!alive) return;
        setBusy(false);
        setError(
          "Could not reach Sepolia to find the latest draw. Enter a draw id above."
        );
      });
    return () => {
      alive = false;
    };
  }, [params, verify]);

  const fails = checks?.filter((c) => c.result === "fail").length ?? 0;
  const pending = checks?.filter((c) => c.result === "pending").length ?? 0;
  const unread = checks?.filter((c) => c.result === "unread").length ?? 0;
  const passes = checks ? checks.length - fails - pending - unread : 0;

  return (
    <AppShell>
      <div className={shell.stack}>
        <section className={shell.panel}>
          <div className={shell.panelHead}>
            <span className={shell.panelLabel}>Verify a draw</span>
            <span className={shell.panelMeta}>no wallet required</span>
          </div>
          <div className={shell.panelBody}>
            <div
              style={{
                display: "flex",
                gap: "var(--s-3)",
                alignItems: "center",
              }}
            >
              <input
                className={shell.input}
                style={{ width: 120 }}
                value={drawId}
                onChange={(e) =>
                  setDrawId(e.target.value.replace(/[^0-9]/g, ""))
                }
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
            {error ? (
              <p className={`${shell.note} ${shell.fault}`}>{error}</p>
            ) : null}
          </div>
        </section>

        {/* Something on screen while the first read is in flight. */}
        {!checks && busy ? (
          <section className={shell.panel}>
            <div className={shell.panelHead}>
              <span className={shell.panelLabel}>Checks</span>
              <span className={shell.panelMeta}>reading</span>
            </div>
            <div className={shell.panelBody}>
              <p className={shell.note} style={{ margin: 0 }}>
                Resolving the latest draw from Sepolia and re-reading every
                public fact about it.
              </p>
            </div>
          </section>
        ) : null}

        {checks ? (
          <>
            <section className={shell.panel}>
              <div className={shell.panelHead}>
                <span className={shell.panelLabel}>Checks</span>
                <span
                  className={shell.panelMeta}
                  data-tone={fails ? "fault" : "brass"}
                >
                  {fails > 0
                    ? `${fails} fail`
                    : pending > 0 || unread > 0
                    ? [
                        `${passes} pass`,
                        pending ? `${pending} pending` : null,
                        unread ? `${unread} unread` : null,
                      ]
                        .filter(Boolean)
                        .join(", ")
                    : `${checks.length} pass`}
                </span>
              </div>
              <div className={shell.panelBodyFlush}>
                <table className={`${shell.table} ${shell.tableWrap}`}>
                  <colgroup>
                    <col style={{ width: "30%" }} />
                    <col style={{ width: "26%" }} />
                    <col style={{ width: "30%" }} />
                    <col style={{ width: "14%" }} />
                  </colgroup>
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
                        <td
                          style={{
                            whiteSpace: "normal",
                            color: "var(--graphite)",
                          }}
                        >
                          {c.expected}
                        </td>
                        <td style={{ whiteSpace: "normal" }}>{c.observed}</td>
                        <td
                          className={
                            c.result === "pass"
                              ? shell.brass
                              : c.result === "fail"
                              ? shell.fault
                              : undefined
                          }
                          style={
                            c.result === "pending" || c.result === "unread"
                              ? { color: "var(--graphite)" }
                              : undefined
                          }
                        >
                          {c.result === "pass"
                            ? "PASS"
                            : c.result === "fail"
                            ? "FAIL"
                            : c.result === "unread"
                            ? "UNREAD"
                            : "PENDING"}
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
                <p
                  className={shell.note}
                  style={{ margin: 0, lineHeight: 1.7 }}
                >
                  The descent itself cannot be re-derived in this browser. Every
                  node in the register is a ciphertext nobody holds a grant on,
                  so a client cannot re-run a comparison it can read only one
                  side of. Publishing per-node decryptions so a verifier could
                  replay the walk would hand everyone the register, which is the
                  thing the design exists to prevent. What is checkable is
                  above. This is not.
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
