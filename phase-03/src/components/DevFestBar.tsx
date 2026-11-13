import SparkStatus from "@/components/SparkStatus";

/**
 * DevFest Mangaluru 2026 app bar, shared by every phase.
 *
 * `sparkChecks`: this app's health routes that proxy to the DGX Spark. When given, the
 * right-hand chip shows live Spark reachability. Phase 01 needs no Spark and passes none.
 */
export default function DevFestBar({
  phase,
  sparkChecks,
}: {
  phase: string;
  sparkChecks?: string[];
}) {
  return (
    <header className="df-bar">
      <div className="df-bar-inner">
        <div className="df-lockup" aria-label="DevFest Mangaluru 2026">
          <span className="df-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="df-word">
            <b>DevFest</b> Mangaluru <span>2026</span>
          </span>
        </div>
        <div className="df-meta">
          <span className="df-chip phase">Phase {phase}</span>
          {sparkChecks && sparkChecks.length > 0 ? (
            <SparkStatus checks={sparkChecks} />
          ) : (
            <span className="df-chip status" data-state="ok">
              Runs in your browser
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
