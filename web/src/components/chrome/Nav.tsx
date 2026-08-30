"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useBalance } from "wagmi";

import { REPO_URL } from "@/lib/measurements";
import { PRIVY_APP_ID } from "@/lib/wagmi";
import { SortisMark } from "./SortisMark";
import styles from "./Nav.module.css";

/**
 * Top nav. Brief v2 section 2.
 *
 * One shell, two contents. The marketing surface gets section links and a
 * call to action; the app surface gets a shard label, route tabs and a wallet
 * connect. Splitting them into two components would duplicate the shell and
 * let the two drift, which is the same argument that put all three surfaces
 * behind one middleware.
 *
 * The wallet button is deliberately not rendered here on the marketing
 * surface. Nothing on the landing page needs a wallet, and a connect prompt
 * on a page with nothing to sign is friction that reads as a consumer app.
 */

const MARKETING_LINKS = [
  { href: "/#the-wall", label: "Architecture" },
  { href: "/#what-is-private", label: "Privacy" },
  { href: "/app/verify", label: "Verify" },
  { href: "/docs", label: "Docs" },
];

const APP_TABS = [
  { href: "/app/register", label: "Register" },
  { href: "/app", label: "Draw" },
  { href: "/app/verify", label: "Verify" },
];

export function Nav({ surface }: { surface: "marketing" | "app" }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A route change should never leave the sheet hanging open over the new page.
  useEffect(() => setOpen(false), [pathname]);

  const links = surface === "app" ? APP_TABS : MARKETING_LINKS;

  /** The Draw tab lives at /app, so it must not match every /app/* route. */
  const isActive = (href: string) =>
    href === "/app" ? pathname === "/app" : pathname === href;

  return (
    <>
      <nav className={styles.nav} data-scrolled={scrolled}>
        <div className={styles.inner}>
          <Link
            className={styles.brand}
            href={surface === "app" ? "/app" : "/"}
          >
            <SortisMark className={styles.mark} />
            <span className={styles.wordmark}>Sortis</span>
          </Link>

          {surface === "app" ? (
            <>
              <span className={styles.divider} aria-hidden="true" />
              <span className={styles.shard}>SHARD 001</span>
            </>
          ) : null}

          <div className={styles.links}>
            {links.map((item) => (
              <Link
                key={item.href}
                className={styles.link}
                href={item.href}
                data-active={
                  surface === "app" ? isActive(item.href) : undefined
                }
              >
                {item.label}
              </Link>
            ))}
          </div>

          <div className={styles.right}>
            {surface === "app" ? (
              <span className={styles.walletSlot}>
                <WalletButton />
              </span>
            ) : (
              <>
                <a className={styles.repo} href={REPO_URL}>
                  Repo
                </a>
                <Link className={styles.cta} href="/app">
                  Open the app
                  <span className={styles.ctaArrow} aria-hidden="true">
                    ↗
                  </span>
                </Link>
              </>
            )}

            <button
              type="button"
              className={styles.burger}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <span className={styles.burgerLine} />
              <span className={styles.burgerLine} />
            </button>
          </div>
        </div>
      </nav>

      {open ? (
        <div className={styles.sheet}>
          {links.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
          {surface === "marketing" ? <a href={REPO_URL}>Repo</a> : null}
        </div>
      ) : null}

      <div className={styles.spacer} />
    </>
  );
}

/**
 * Wallet connect.
 *
 * Split in two so `usePrivy` is never called without a PrivyProvider above it.
 * The hook itself is called unconditionally inside PrivyWalletButton; what is
 * conditional is which component renders, and that is decided by a build-time
 * constant. Calling it unguarded is what made the production build fail with
 * "useWallets was called outside the PrivyProvider component".
 */
/**
 * The address here comes from WAGMI, not from Privy.
 *
 * Privy restores its session on refresh before the wagmi connector reattaches,
 * and for a while the two disagree. This button used to read Privy's user
 * record, so the header showed a connected address while every screen, which
 * reads wagmi, said "not connected". The only way out was to disconnect and
 * connect again. Reading the same source the screens read means the header
 * cannot claim more than the app can actually do.
 *
 * WalletBridge in providers.tsx closes the gap; naming the in-between state
 * here is what makes it visible if it ever fails to.
 */
function WalletButton() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { address: wagmiAddress } = useAccount();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const address = wagmiAddress ?? "";
  const linking = authenticated && !wagmiAddress;

  // Sepolia ETH, which is public and is what a judge actually runs out of.
  const { data: eth } = useBalance({
    address: address || undefined,
    query: { enabled: Boolean(address) },
  });

  // Close on an outside click or Escape, the way a menu is expected to behave.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(`[data-wallet-menu]`))
        setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard denied. The full address is on screen to select by hand.
    }
  };

  if (!ready) {
    return <span className={styles.walletIdle}>wallet</span>;
  }

  if (!authenticated) {
    return (
      <button type="button" className={styles.cta} onClick={login}>
        Connect wallet
      </button>
    );
  }

  const short = address
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : "connecting";

  return (
    <div className={styles.walletWrap} data-wallet-menu>
      <button
        type="button"
        className={styles.walletConnected}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span
          className={styles.walletDot}
          data-linking={linking || undefined}
          aria-hidden="true"
        />
        {short}
      </button>

      {open ? (
        <div className={styles.walletCard} role="menu">
          <p className={styles.walletAddress}>
            {address || "Signed in to Privy, waiting for the wallet to attach."}
          </p>

          <button
            type="button"
            className={styles.walletRow}
            onClick={copy}
            disabled={!address}
          >
            {copied ? "Copied" : "Copy address"}
          </button>

          <div className={styles.walletDivider} />

          <div className={styles.walletStat}>
            <span className={styles.walletStatKey}>Gas</span>
            <span className={styles.walletStatValue}>
              {eth
                ? `${Number(eth.formatted).toFixed(4)} ${eth.symbol}`
                : "reading"}
            </span>
          </div>

          {/*
            The stake is a euint64 and there is no plaintext balance to put
            here. Showing a number would mean running the EIP-712 decryption
            from the nav, which is the Register screen's job and needs a
            signature. Naming it as encrypted is the honest version, and the
            link goes where it can actually be read.
          */}
          <div className={styles.walletStat}>
            <span className={styles.walletStatKey}>Stake</span>
            <Link
              href="/app/register"
              className={styles.walletStatLink}
              onClick={() => setOpen(false)}
            >
              encrypted, decrypt on Register
            </Link>
          </div>

          <div className={styles.walletDivider} />

          <button
            type="button"
            className={`${styles.walletRow} ${styles.walletDisconnect}`}
            onClick={() => {
              setOpen(false);
              void logout();
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
