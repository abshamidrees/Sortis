"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";

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
  const isActive = (href: string) => (href === "/app" ? pathname === "/app" : pathname === href);

  return (
    <>
      <nav className={styles.nav} data-scrolled={scrolled}>
        <div className={styles.inner}>
          <Link className={styles.brand} href={surface === "app" ? "/app" : "/"}>
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
                data-active={surface === "app" ? isActive(item.href) : undefined}
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
function WalletButton() {
  if (!PRIVY_APP_ID) {
    return <span className={styles.walletIdle}>wallet unconfigured</span>;
  }
  return <PrivyWalletButton />;
}

/**
 * Privy's own button is not used: it arrives in Privy's brand, and the nav is
 * the one element on every screen. This renders the Sortis button and calls
 * `login()`, so the only Privy surface a user sees is the wallet picker
 * itself, themed to brass on stone in privyConfig.
 *
 * Connected shows a brass dot and the truncated address in IBM Plex Mono, and
 * clicking disconnects. The dot is --brass rather than --seal on purpose:
 * --seal means encrypted in this palette, and a connection indicator in that
 * colour would read as a privacy state.
 */
function PrivyWalletButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();

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

  const address = user?.wallet?.address ?? "";
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "connected";

  return (
    <button type="button" className={styles.walletConnected} onClick={logout} title="Disconnect">
      <span className={styles.walletDot} aria-hidden="true" />
      {short}
    </button>
  );
}
