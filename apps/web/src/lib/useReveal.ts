'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Scroll-triggered reveal, backing `<Reveal>` and anywhere else that needs
 * the raw visible flag directly (e.g. animating a bar's width, which can't
 * be done by toggling a class on an ancestor).
 *
 * Fires once: the observer disconnects after the first intersection, so an
 * element that's scrolled past and back doesn't re-animate. The actual
 * motion (or lack of it under `prefers-reduced-motion`) lives in CSS, not
 * here — this hook only ever reports true/false.
 */
export function useReveal<T extends HTMLElement>(options?: IntersectionObserverInit) {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Already in view on mount (common above the fold) — skip the observer
    // round-trip and just show it immediately.
    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px', ...options },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [ref, visible] as const;
}
