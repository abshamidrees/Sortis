"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { REPO_URL } from "@/lib/measurements";
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
 * Wallet connect, loaded only on the app surface.
 *
 * RainbowKit's ConnectButton pulls the whole wagmi connector graph, so it is
 * imported lazily rather than shipped to the marketing pages that never use
 * it.
 */
function WalletButton() {
  const [Button, setButton] = useState<React.ComponentType<{ showBalance?: boolean }> | null>(null);

  useEffect(() => {
    let alive = true;
    import("@rainbow-me/rainbowkit").then((mod) => {
      if (alive) setButton(() => mod.ConnectButton as never);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!Button) {
    return <span className={styles.shard}>Wallet</span>;
  }
  return <Button showBalance={false} />;
}
