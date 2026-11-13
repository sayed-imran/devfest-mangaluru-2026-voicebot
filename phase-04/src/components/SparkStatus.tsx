"use client";

import { useEffect, useState } from "react";

type State = "checking" | "ok" | "partial" | "down";

const LABEL: Record<State, string> = {
  checking: "Connecting to DGX Spark…",
  ok: "DGX Spark connected",
  partial: "DGX Spark partly reachable",
  down: "DGX Spark unreachable",
};

const POLL_MS = 15_000;

/**
 * Live reachability of the DGX Spark, via this app's own health routes
 * (each one proxies to a service on the Spark). Re-checks every 15 s and
 * whenever the tab regains focus.
 */
export default function SparkStatus({ checks }: { checks: string[] }) {
  const [state, setState] = useState<State>("checking");
  const [detail, setDetail] = useState("");
  // Stable dependency: the array prop is re-created on every server render.
  const key = checks.join("|");

  useEffect(() => {
    let cancelled = false;
    const paths = key.split("|");

    async function probe() {
      const results = await Promise.all(
        paths.map(async (path) => {
          try {
            const res = await fetch(path, {
              cache: "no-store",
              signal: AbortSignal.timeout(5000),
            });
            const data = (await res.json()) as { ok?: boolean };
            return { path, ok: res.ok && data.ok !== false };
          } catch {
            return { path, ok: false };
          }
        }),
      );
      if (cancelled) return;

      const okCount = results.filter((r) => r.ok).length;
      setState(
        okCount === results.length ? "ok" : okCount === 0 ? "down" : "partial",
      );
      setDetail(
        results.map((r) => `${r.path}: ${r.ok ? "ok" : "failed"}`).join("\n"),
      );
    }

    void probe();
    const timer = setInterval(probe, POLL_MS);
    const onFocus = () => void probe();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [key]);

  return (
    <span
      className="df-chip status"
      data-state={state}
      role="status"
      title={detail || "Checking the DGX Spark on the local network"}
    >
      {LABEL[state]}
    </span>
  );
}
