"use client";

import { useEffect } from "react";

/**
 * When the viewer runs inside an iframe (e.g. a Squarespace Code Block),
 * report the page height to the parent so the embed snippet can size the
 * iframe with no inner scrollbar, and ask the parent to make the iframe
 * cover the screen while the viewer is in its iPhone fullscreen fallback
 * (element fullscreen isn't available to iframes on iPhone). The messages
 * carry only a height/flag, so posting to "*" leaks nothing.
 */
export function EmbedHeightReporter({ slug, targetId }: { slug: string; targetId: string }) {
  useEffect(() => {
    if (window.parent === window) return;
    // Measure the embed content, not <html>: the root layout stretches the
    // document to the iframe's own height, which would never shrink.
    const target = document.getElementById(targetId);
    if (!target) return;
    let last = 0;
    const report = () => {
      const height = Math.ceil(target.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      window.parent.postMessage({ type: "boat360:height", slug, height }, "*");
    };
    const ro = new ResizeObserver(report);
    ro.observe(target);
    report();
    const onFullscreen = (e: Event) => {
      const on = Boolean((e as CustomEvent<{ on: boolean }>).detail?.on);
      window.parent.postMessage({ type: "boat360:fullscreen", slug, on }, "*");
    };
    window.addEventListener("boat360:pseudo-fullscreen", onFullscreen);
    return () => {
      ro.disconnect();
      window.removeEventListener("boat360:pseudo-fullscreen", onFullscreen);
    };
  }, [slug, targetId]);
  return null;
}
