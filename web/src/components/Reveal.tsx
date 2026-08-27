"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Scroll reveal. A short rise and fade, once, on first intersection.
 *
 * fd's motion vocabulary is minimal and pro's is a spring, so this lands
 * between them: a 40px rise on --ease-settle, which overshoots very slightly.
 * It runs once and never again, because a section that re-animates every time
 * it scrolls past reads as decoration rather than arrival.
 *
 * VISIBLE BY DEFAULT, and that matters. The obvious implementation starts at
 * opacity 0 and waits for an observer, which means the content does not exist
 * for anything that never scrolls: no-JS readers, print, a crawler, a
 * full-page screenshot. Here the server renders the content visible, and the
 * hidden state is applied on mount only to elements that are actually below
 * the fold. Anything already on screen, and everything under
 * prefers-reduced-motion, simply stays put.
 */
export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Only hide what the reader has not reached yet. Hiding something already
    // in view would make it flash out and back in on load.
    const box = node.getBoundingClientRect();
    if (box.top < window.innerHeight * 0.9) return;

    setHidden(true);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setHidden(false);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-revealed={!hidden}
      style={{
        opacity: hidden ? 0 : 1,
        transform: hidden ? "translateY(40px)" : "none",
        transition: `opacity 420ms var(--ease-step) ${delay}ms, transform 520ms var(--ease-settle) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}
