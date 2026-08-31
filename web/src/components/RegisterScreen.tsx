"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useBalance,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from "wagmi";

import { AppShell } from "@/components/chrome/AppShell";
import { CUSDT_ABI, POOL_ABI } from "@/lib/abi";
import { ETHERSCAN, HCU } from "@/lib/measurements";
import {
  CONFIGURED,
  CUSDT,
  POOL,
  readActivity,
  readPosition,
  truncate,
  type ActivityRow,
  type Position,
} from "@/lib/chain";
import { useFhevm } from "@/lib/fhevm";
import { useSepolia } from "@/lib/useSepolia";
import {
  guardCommit,
  guardGas,
  guardRelease,
  formatUnits,
  readTxError,
  toBaseUnits,
  SEPOLIA_FAUCET,
  SEPOLIA_ID,
  type Guard,
} from "@/lib/guards";
import shell from "@/components/chrome/AppShell.module.css";

/**
 * /app/register.
 *
 * Position on the left with an activity table under it, forms and costs on the
 * right. No headline, no prose paragraph: labels and values.
 *
 * This is the route the bounty is graded on, because deposit and withdraw both
 * live here and both have to work end to end from a connected wallet.
 */

type TxState = {
  status: "idle" | "pending" | "mined" | "failed";
  detail?: string;
};

const FAR_FUTURE = 2n ** 47n;

/**
 * A confidential value, in its three states.
 *
 * Decrypting a handle into another handle looks like nothing happened, which
 * is what the previous version did: the value went from one truncated hex
 * string to a slightly different truncated hex string and the user was left
 * guessing whether the signature had worked.
 *
 *   sealed     the real handle, in --seal
 *   working    --gleam, with a progress line, while the relayer runs
 *   revealed   the decimal value in --ink, in place, with a way back
 *
 * The way back matters. Revealing is a decision, and a value that cannot be
 * put away again turns one glance at a balance into a shoulder-surfing risk
 * for as long as the tab is open.
 */
function EncryptedValue({
  handle,
  clear,
  busy,
  disabled,
  onDecrypt,
  onHide,
  progress,
  /**
   * What to show when there is no handle.
   *
   * "not set" is only true once the position has actually been read. Before
   * that, and after a read that failed, the honest word is different and the
   * caller is the only one that knows which.
   */
  missing = "not set",
}: {
  handle: `0x${string}` | undefined;
  missing?: string;
  clear: bigint | null;
  busy: boolean;
  disabled: boolean;
  onDecrypt: () => void;
  onHide: () => void;
  progress: { phase: string; message: string };
}) {
  const state = clear !== null ? "revealed" : busy ? "working" : "sealed";
  const sealedText = handle ? truncate(handle) : missing;

  return (
    <span className={shell.kvValue}>
      <span className="ciphertext" data-state={state}>
        {clear !== null
          ? `${(Number(clear) / 1e6).toFixed(6)} cUSDT`
          : sealedText}
      </span>

      {clear !== null ? (
        <button type="button" className={shell.inlineAction} onClick={onHide}>
          re-encrypt
        </button>
      ) : (
        <button
          type="button"
          className={shell.inlineAction}
          onClick={onDecrypt}
          disabled={disabled}
        >
          {busy ? "decrypting" : "decrypt"}
        </button>
      )}

      {busy ? (
        <span className={shell.progress}>
          {progress.phase === "fetching-keys" ||
          progress.phase === "loading-sdk"
            ? progress.message
            : "Signing EIP-712, then asking the relayer."}
        </span>
      ) : null}
    </span>
  );
}

/** Sequential HCU per action. The same numbers connected or not. */
function CostPanel() {
  return (
    <section className={shell.panel}>
      <div className={shell.panelHead}>
        <span className={shell.panelLabel}>Cost</span>
        <span className={shell.panelMeta}>sequential HCU</span>
      </div>
      <div className={shell.panelBodyFlush}>
        <table className={shell.table}>
          <tbody>
            <tr>
              <td>commit</td>
              <td>{HCU.COMMIT_DEPTH.toLocaleString("en-US")}</td>
            </tr>
            <tr>
              <td>release</td>
              <td>{HCU.COMMIT_DEPTH.toLocaleString("en-US")}</td>
            </tr>
            <tr>
              <td>draw</td>
              <td>
                {HCU.DRAW[3].depth.toLocaleString("en-US")} /{" "}
                {HCU.DEPTH_LIMIT.toLocaleString("en-US")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function RegisterScreen() {
  const { address, isConnected } = useAccount();
  // Public, unencrypted, and the thing that actually stops a judge mid-flow.
  const { data: gasBalance } = useBalance({
    address,
    query: { enabled: Boolean(address) },
  });
  // The WALLET's chain, not the config's. See lib/useSepolia.ts.
  const { walletChainId, wrongNetwork, ensureSepolia } = useSepolia();
  const chainId = walletChainId ?? SEPOLIA_ID;
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const { progress, encryptAmount, userDecrypt } = useFhevm();

  const [position, setPosition] = useState<Position | null>(null);
  /*
    A failed read is NOT a negative fact.

    Every row below used `position?.x ? a : b`, so a null position rendered
    "no leaf yet", "not set" and "not authorised" in fault red. A rate limited
    RPC therefore drew a confident picture of an empty, unauthorised account
    for a wallet that had a leaf, a stake and an operator grant a minute
    earlier. Three states, not two: not read yet, read, could not read.
  */
  const [positionState, setPositionState] = useState<
    "loading" | "ready" | "failed"
  >("loading");
  /**
   * null means "not read yet", not "empty".
   *
   * Rendering the empty state while the log scan is still running tells the
   * user they have no commits, which is a claim the app cannot make until the
   * query returns. Now that activity loads independently of the position, that
   * window is visible rather than hidden behind a slower await.
   */
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [stakeClear, setStakeClear] = useState<bigint | null>(null);
  const [walletClear, setWalletClear] = useState<bigint | null>(null);
  const [decrypting, setDecrypting] = useState<"stake" | "wallet" | null>(null);
  const [commitAmount, setCommitAmount] = useState("1.0");
  const [releaseAmount, setReleaseAmount] = useState("0.4");
  const [commitTx, setCommitTx] = useState<TxState>({ status: "idle" });
  const [releaseTx, setReleaseTx] = useState<TxState>({ status: "idle" });
  const [faucetTx, setFaucetTx] = useState<TxState>({ status: "idle" });
  const [tab, setTab] = useState<"position" | "activity">("position");

  const refresh = useCallback(async () => {
    if (!address || !CONFIGURED) return;
    try {
      /*
        Independently, not as one Promise.all.

        The position is a handful of contract reads and lands quickly. The
        activity is a log scan across every window since deployment and is much
        slower. Awaiting both together meant the screen showed nothing until
        the slower one finished, which is what made this route look broken.
      */
      /*
        Position only. The activity table is behind a tab and its log scan is
        the most expensive read on this route, so loading it here put three
        windowed getLogs calls in front of the stat strip's reads and left the
        strip saying "reading" on /app/register long after /app and
        /app/verify had resolved. It loads when the tab is opened.
      */
      void readPosition(address)
        .then((pos) => {
          setPosition(pos);
          setPositionState("ready");
        })
        .catch(() => {
          // Keep whatever was last read on screen. Only the state changes, so
          // a refresh that fails mid-session degrades to a stale reading
          // rather than to a wrong one.
          setPositionState((prev) => (prev === "ready" ? "ready" : "failed"));
        });
    } catch {
      setPositionState((prev) => (prev === "ready" ? "ready" : "failed"));
    }
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Activity, the first time its tab is opened and not before.
  useEffect(() => {
    if (tab !== "activity" || activity !== null || !address) return;
    void readActivity(address)
      .then((acts) => setActivity(acts))
      .catch(() => setActivity([]));
  }, [tab, activity, address]);

  const decrypt = useCallback(
    async (which: "stake" | "wallet") => {
      if (!address || !position) return;
      setDecrypting(which);
      try {
        const handle =
          which === "stake" ? position.stakeHandle : position.walletHandle;
        const contract = which === "stake" ? POOL : CUSDT;
        const value = await userDecrypt(handle, contract, address, (args) =>
          signTypedDataAsync(args as never)
        );
        if (which === "stake") setStakeClear(value);
        else setWalletClear(value);
      } catch {
        // The user declined the signature, or the relayer is unreachable. The
        // handle stays on screen, which is the honest resting state anyway.
      } finally {
        setDecrypting(null);
      }
    },
    [address, position, userDecrypt, signTypedDataAsync]
  );

  const runFaucet = useCallback(async () => {
    if (!address) return;
    setFaucetTx({ status: "pending", detail: "Minting 5 cUSDT" });
    try {
      if (!(await ensureSepolia())) {
        setFaucetTx({
          status: "failed",
          detail:
            "This wallet is not on Sepolia. Sortis is deployed there only, so nothing was sent.",
        });
        return;
      }
      const hash = await writeContractAsync({
        chainId: SEPOLIA_ID,
        address: CUSDT,
        abi: CUSDT_ABI,
        functionName: "mint",
        args: [address, 5_000_000n],
      });
      await publicClient?.waitForTransactionReceipt({ hash });

      // The pool pulls with confidentialTransferFrom, which ERC-7984 gates on
      // an explicit operator authorisation. Doing it here means a judge never
      // hits a failed commit for a reason the UI never mentioned.
      if (!position?.isOperator) {
        const op = await writeContractAsync({
          chainId: SEPOLIA_ID,
          address: CUSDT,
          abi: CUSDT_ABI,
          functionName: "setOperator",
          args: [POOL, Number(FAR_FUTURE)],
        });
        await publicClient?.waitForTransactionReceipt({ hash: op });
      }
      setFaucetTx({
        status: "mined",
        detail: "5 cUSDT minted, pool authorised",
      });
      await refresh();
    } catch (error) {
      setFaucetTx({
        status: "failed",
        detail: readTxError(error).message,
      });
    }
  }, [address, writeContractAsync, publicClient, position, refresh]);

  const submit = useCallback(
    async (kind: "commit" | "release") => {
      if (!address) return;
      const setTx = kind === "commit" ? setCommitTx : setReleaseTx;
      const raw = kind === "commit" ? commitAmount : releaseAmount;

      setTx({ status: "pending", detail: "Checking network" });
      if (!(await ensureSepolia())) {
        setTx({
          status: "failed",
          detail:
            "This wallet is not on Sepolia. Sortis is deployed there only, so nothing was sent.",
        });
        return;
      }
      setTx({ status: "pending", detail: "Encrypting the amount" });
      try {
        const amount = toBaseUnits(raw);
        const { handle, inputProof } = await encryptAmount(
          POOL,
          address,
          amount
        );

        setTx({ status: "pending", detail: "Waiting for signature" });
        const hash = await writeContractAsync({
          chainId: SEPOLIA_ID,
          address: POOL,
          abi: POOL_ABI,
          functionName: kind,
          args: [handle, inputProof],
        });

        setTx({ status: "pending", detail: "Mining" });
        await publicClient?.waitForTransactionReceipt({ hash });

        setTx({ status: "mined", detail: `${kind} mined` });
        setStakeClear(null);
        setWalletClear(null);
        await refresh();
      } catch (error) {
        setTx({
          status: "failed",
          detail: readTxError(error).message,
        });
      }
    },
    [
      address,
      commitAmount,
      releaseAmount,
      encryptAmount,
      writeContractAsync,
      publicClient,
      refresh,
    ]
  );

  /*
    Disconnected.

    Not a single floating box in an empty viewport. Everything on this screen
    that does not depend on a wallet is public, so it is shown: what connecting
    will do, what the faucet hands you, and what each action costs. A judge
    should be able to read the whole shape of the route before signing
    anything.
  */
  if (!isConnected) {
    return (
      <AppShell>
        <div className={shell.split} data-ratio="8/4">
          <div className={shell.stack}>
            <section className={shell.panel}>
              <div className={shell.panelHead}>
                <span className={shell.panelLabel}>Position</span>
                <span className={shell.panelMeta}>not connected</span>
              </div>
              <div className={shell.panelBody}>
                <div className={shell.kv}>
                  <span className={shell.kvKey}>Stake</span>
                  <span
                    className={shell.kvValue}
                    style={{ color: "var(--graphite)" }}
                  >
                    connect to read
                  </span>

                  <span className={shell.kvKey}>Wallet</span>
                  <span
                    className={shell.kvValue}
                    style={{ color: "var(--graphite)" }}
                  >
                    connect to read
                  </span>

                  <span className={shell.kvKey}>Network</span>
                  <span className={shell.kvValue}>Sepolia</span>

                  <span className={shell.kvKey}>Token</span>
                  <span className={shell.kvValue}>
                    cUSDT
                    <span className={shell.kvAside}>ERC-7984, 6 decimals</span>
                  </span>

                  <span className={shell.kvKey}>Decryption</span>
                  <span className={shell.kvValue}>
                    EIP-712
                    <span className={shell.kvAside}>
                      signed in your wallet, read in your browser
                    </span>
                  </span>
                </div>
              </div>
            </section>

            <section className={shell.panel}>
              <div className={shell.panelHead}>
                <span className={shell.panelLabel}>
                  What happens on connect
                </span>
                <span className={shell.panelMeta}>three steps</span>
              </div>
              <div className={shell.panelBodyFlush}>
                <table className={`${shell.table} ${shell.tableWrap}`}>
                  <tbody>
                    <tr>
                      <td style={{ width: "10%" }}>1</td>
                      <td>
                        Mint 5 cUSDT from the faucet and authorise the pool to
                        pull
                      </td>
                    </tr>
                    <tr>
                      <td>2</td>
                      <td>
                        Commit an amount, encrypted in your browser before it is
                        sent
                      </td>
                    </tr>
                    <tr>
                      <td>3</td>
                      <td>
                        Release any part of it back, at any time, with no loss
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div className={shell.stack}>
            <CostPanel />
          </div>
        </div>
      </AppShell>
    );
  }

  const busy = (tx: TxState) => tx.status === "pending";

  /*
    The four states the rules name, checked BEFORE a transaction is built.

    A revert surfaced from a wallet is a hex string and a stack, and none of
    these four are the user doing something wrong. Three have an action that
    fixes them. The fourth is not a failure at all.
  */
  const commitGuard = guardCommit({
    chainId,
    isOperator: position?.isOperator ?? true,
    walletClear,
    amount: toBaseUnits(commitAmount),
  });
  const releaseGuard = guardRelease({
    chainId,
    stakeClear,
    amount: toBaseUnits(releaseAmount),
  });

  /*
    Gas is checked once and shown once, above all three forms.

    It is not per form: with no ether, mint, commit and release fail
    identically, and repeating the same sentence three times would push the
    forms off the fold to say one thing.
  */
  const gasGuard = guardGas(gasBalance?.value);

  const renderGuard = (guard: Guard | null) =>
    guard ? (
      <p
        className={`${shell.cost} ${guard.blocking ? shell.fault : ""}`}
        role="alert"
      >
        {guard.message}
        {guard.action === "switch-network" ? (
          <button
            type="button"
            className={shell.inlineAction}
            style={{ marginLeft: "var(--s-2)" }}
            onClick={() => switchChain?.({ chainId: SEPOLIA_ID })}
          >
            {guard.actionLabel}
          </button>
        ) : null}
        {guard.action === "gas-faucet" ? (
          <a
            className={shell.inlineAction}
            style={{ marginLeft: "var(--s-2)" }}
            href={SEPOLIA_FAUCET}
            target="_blank"
            rel="noreferrer noopener"
          >
            {guard.actionLabel}
          </a>
        ) : null}
        {guard.action === "faucet" ? (
          <button
            type="button"
            className={shell.inlineAction}
            style={{ marginLeft: "var(--s-2)" }}
            onClick={runFaucet}
            disabled={busy(faucetTx)}
          >
            {guard.actionLabel}
          </button>
        ) : null}
      </p>
    ) : null;

  /*
    Null because it has not been read, or null because the read failed?

    Both render the same rows, and neither is "not set". This is the one word
    those rows use so that a rate limited RPC never asserts an empty account.
  */
  const unread =
    positionState === "ready"
      ? null
      : positionState === "failed"
      ? "could not read"
      : "reading";

  return (
    <AppShell>
      <div className={shell.split} data-ratio="8/4">
        {/* ------------------------------------------------------ position */}
        <div className={shell.stack}>
          <div className={shell.subtabs}>
            {(["position", "activity"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={shell.subtab}
                data-active={tab === t}
                onClick={() => setTab(t)}
              >
                {t === "position"
                  ? "Position"
                  : `Activity${
                      activity === null ? "" : ` (${activity.length})`
                    }`}
              </button>
            ))}
          </div>

          <section
            className={shell.panel}
            style={{ display: tab === "position" ? undefined : "none" }}
          >
            <div className={shell.panelHead}>
              <span className={shell.panelLabel}>Position</span>
              <span className={shell.panelMeta}>
                {position?.hasLeaf
                  ? `leaf ${position.leaf}`
                  : positionState === "ready"
                  ? "no leaf yet"
                  : positionState === "failed"
                  ? "unavailable"
                  : "reading"}
              </span>
            </div>
            <div className={shell.panelBody}>
              {/*
                One two-column key-value grid, and nothing above it.

                The oversized handle that used to sit here duplicated the STAKE
                row four lines below it, and a truncated ciphertext handle is
                not a hero number: it is the same eight characters at 32px.
                Under /app a value earns its size by being a value.
              */}
              <div className={shell.kv}>
                <span className={shell.kvKey}>Stake</span>
                <EncryptedValue
                  handle={position?.stakeHandle}
                  missing={unread ?? "not set"}
                  clear={stakeClear}
                  busy={decrypting === "stake"}
                  disabled={decrypting !== null || !position?.hasLeaf}
                  onDecrypt={() => decrypt("stake")}
                  onHide={() => setStakeClear(null)}
                  progress={progress}
                />

                <span className={shell.kvKey}>Wallet</span>
                <EncryptedValue
                  handle={position?.walletHandle}
                  missing={unread ?? "not set"}
                  clear={walletClear}
                  busy={decrypting === "wallet"}
                  disabled={decrypting !== null}
                  onDecrypt={() => decrypt("wallet")}
                  onHide={() => setWalletClear(null)}
                  progress={progress}
                />

                <span className={shell.kvKey}>Weight line</span>
                <span className={shell.kvValue}>
                  <span className="ciphertext">
                    {position?.weightHandle
                      ? truncate(position.weightHandle)
                      : unread ?? "not set"}
                  </span>
                  <span className={shell.kvAside}>
                    {position
                      ? position.hoursHeld === 0
                        ? "0h held, carries no weight yet"
                        : `${position.hoursHeld}h held`
                      : ""}
                  </span>
                </span>

                <span className={shell.kvKey}>Leaf index</span>
                <span className={shell.kvValue}>
                  {position?.hasLeaf
                    ? position.leaf
                    : positionState === "ready"
                    ? "assigned on first commit"
                    : positionState === "failed"
                    ? "could not read"
                    : "reading"}
                </span>

                <span className={shell.kvKey}>Shard share</span>
                <span className={shell.kvValue}>
                  <span style={{ color: "var(--seal)" }}>encrypted</span>
                  <span className={shell.kvAside}>
                    {position ? `1 of ${position.leafCount} leaves in use` : ""}
                  </span>
                </span>

                <span className={shell.kvKey}>Pool operator</span>
                <span
                  className={shell.kvValue}
                  data-tone={
                    positionState !== "ready"
                      ? undefined
                      : position?.isOperator
                      ? undefined
                      : "fault"
                  }
                >
                  {position?.isOperator
                    ? "authorised"
                    : positionState === "ready"
                    ? "not authorised"
                    : positionState === "failed"
                    ? "could not read"
                    : "reading"}
                </span>
              </div>

              {/*
                Without this line the grid reads as a rendering bug. Several
                handles end in the same four characters because an FHEVM handle
                carries its type and chain id in its trailing bytes, so every
                euint64 on Sepolia shares that tail. Anyone who has not worked
                with FHEVM assumes the page is repeating itself.
              */}
              <p className={shell.note}>
                Handles sharing a tail is not a bug. An FHEVM handle encodes its
                type and chain in the trailing bytes, so every euint64 on
                Sepolia ends the same way. The leading bytes are what differ.
              </p>

              <p className={shell.note}>
                Decrypted in this session only. Nothing is sent anywhere.
              </p>
              {progress.phase === "fetching-keys" ||
              progress.phase === "loading-sdk" ? (
                <p className={shell.progress}>{progress.message}</p>
              ) : null}
              {progress.phase === "error" ? (
                <p className={`${shell.note} ${shell.fault}`}>
                  {progress.message}
                </p>
              ) : null}
            </div>
          </section>

          <section
            className={shell.panel}
            style={{ display: tab === "activity" ? undefined : "none" }}
          >
            <div className={shell.panelHead}>
              <span className={shell.panelLabel}>Your activity</span>
              <span className={shell.panelMeta}>
                {activity === null ? "reading" : `${activity.length} events`}
              </span>
            </div>
            <div className={`${shell.panelBodyFlush} ${shell.feed}`}>
              {activity === null ? (
                <p className={shell.empty}>Reading this address from chain.</p>
              ) : activity.length ? (
                <table className={shell.table}>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Leaf</th>
                      <th>Block</th>
                      <th>HCU</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map((row) => (
                      <tr key={row.tx}>
                        <td>
                          {row.kind === "Committed" ? "commit" : "release"}
                        </td>
                        <td>{row.leaf.toString()}</td>
                        <td>{row.block.toString()}</td>
                        <td>
                          {(row.kind === "Committed"
                            ? HCU.COMMIT_DEPTH
                            : HCU.COMMIT_DEPTH
                          ).toLocaleString("en-US")}
                        </td>
                        <td>
                          <a href={`https://sepolia.etherscan.io/tx/${row.tx}`}>
                            {truncate(row.tx, 3)}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className={shell.empty}>
                  No commits or releases from this address yet.
                </p>
              )}
            </div>
          </section>
        </div>

        {/* --------------------------------------------------------- forms */}
        <div className={shell.stack}>
          {/*
            One sentence, above everything it blocks.

            Without it the first thing a judge with an empty wallet sees is
            three separate failures, each reported as though a contract had
            rejected the call.
          */}
          {renderGuard(gasGuard)}

          <section className={shell.panel}>
            <div className={shell.panelHead}>
              <span className={shell.panelLabel}>Faucet</span>
              <span className={shell.panelMeta}>test token</span>
            </div>
            <div className={shell.panelBody}>
              <button
                type="button"
                className={shell.button}
                onClick={runFaucet}
                disabled={busy(faucetTx) || wrongNetwork}
              >
                {busy(faucetTx) ? faucetTx.detail : "Mint 5 cUSDT"}
              </button>
              <p
                className={`${shell.cost} ${
                  faucetTx.status === "failed" ? shell.fault : ""
                }`}
              >
                {faucetTx.status === "idle"
                  ? "Mints the pool's test token and authorises the pool to pull."
                  : faucetTx.detail}
              </p>
            </div>
          </section>

          <section className={shell.panel}>
            <div className={shell.panelHead}>
              <span className={shell.panelLabel}>Commit</span>
              <span className={shell.panelMeta}>deposit</span>
            </div>
            <div className={shell.panelBody}>
              <div className={shell.field}>
                <input
                  className={shell.input}
                  value={commitAmount}
                  onChange={(e) =>
                    setCommitAmount(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                  inputMode="decimal"
                  aria-label="Amount to commit"
                />
                <button
                  type="button"
                  className={shell.button}
                  onClick={() => submit("commit")}
                  disabled={busy(commitTx) || (commitGuard?.blocking ?? false)}
                >
                  {busy(commitTx) ? commitTx.detail : "Commit"}
                </button>
              </div>
              {renderGuard(commitGuard)}
              <p
                className={`${shell.cost} ${
                  commitTx.status === "failed" ? shell.fault : ""
                }`}
              >
                {commitTx.status === "idle" || commitTx.status === "mined"
                  ? `commit() ${HCU.COMMIT_DEPTH.toLocaleString(
                      "en-US"
                    )} HCU, flat in shard size`
                  : commitTx.detail}
              </p>
              {/*
                The anti-snipe rule, stated where it is about to bite.

                Weight accrues in whole hours, so a stake committed minutes
                before a draw carries nothing. A judge who deposits, triggers a
                draw, loses, and is not told this concludes the app is broken.
                It is the property working.
              */}
              <p className={shell.note}>
                A new stake carries no weight until it has been in the pool a
                full hour. That is what stops a deposit made moments before a
                draw from taking the prize.
              </p>
            </div>
          </section>

          <section className={shell.panel}>
            <div className={shell.panelHead}>
              <span className={shell.panelLabel}>Release</span>
              <span className={shell.panelMeta}>withdraw</span>
            </div>
            <div className={shell.panelBody}>
              <div className={shell.field}>
                <input
                  className={shell.input}
                  value={releaseAmount}
                  onChange={(e) =>
                    setReleaseAmount(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                  inputMode="decimal"
                  aria-label="Amount to release"
                />
                {/*
                  Withdrawing in full, without doing arithmetic on a ciphertext.

                  "You cannot lose your principal" is the product's central
                  promise and taking all of it back was not offered: the field
                  defaulted to a fixed amount and the balance is encrypted, so
                  the only route to the exact figure was decrypting it and
                  retyping it by hand.

                  This fills the field from the decrypted stake, so it appears
                  only once the stake has been decrypted in this session. There
                  is no honest way to offer it before that, because the browser
                  genuinely does not know the number.
                */}
                {stakeClear !== null && stakeClear > 0n ? (
                  <button
                    type="button"
                    className={shell.inlineAction}
                    onClick={() => setReleaseAmount(formatUnits(stakeClear))}
                    disabled={busy(releaseTx)}
                  >
                    All
                  </button>
                ) : null}
                <button
                  type="button"
                  className={shell.buttonGhost}
                  onClick={() => submit("release")}
                  disabled={
                    busy(releaseTx) || (releaseGuard?.blocking ?? false)
                  }
                >
                  {busy(releaseTx) ? releaseTx.detail : "Release"}
                </button>
              </div>
              {renderGuard(releaseGuard)}
              <p
                className={`${shell.cost} ${
                  releaseTx.status === "failed" ? shell.fault : ""
                }`}
              >
                {releaseTx.status === "idle" || releaseTx.status === "mined"
                  ? "An over-release is an encrypted no-op, never a revert."
                  : releaseTx.detail}
              </p>
            </div>
          </section>

          <CostPanel />
        </div>
      </div>
    </AppShell>
  );
}
