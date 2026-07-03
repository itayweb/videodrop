import { useEffect, useRef, useState } from "react";
import { ListVideo, X, ChevronDown, ChevronRight } from "lucide-react";
import { fetchJobs, cancelJob } from "@/lib/api";
import { Progress } from "./ui/progress";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";
import { JobProgress } from "./JobProgress";
import { cn } from "@/lib/utils";

const POLL_MS = 4000;

interface BatchJobState {
  id: string;
  filename: string;
  status: string; // queued | running | done | failed | cancelled
}

interface Props {
  token: string;
  batchId: string;
  batchLabel: string;
  mountName: string;
  jobs: { job_id: string; filename: string }[];
  skippedCount: number;
  onDone: () => void;
}

export function BatchProgress({ token, batchId, batchLabel, mountName, jobs, skippedCount, onDone }: Props) {
  const [states, setStates] = useState<BatchJobState[]>(() =>
    jobs.map((j) => ({ id: j.job_id, filename: j.filename, status: "queued" }))
  );
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      try {
        const data = await fetchJobs(token, Math.max(100, jobs.length * 2));
        if (stopped) return;
        const activeById = new Map<string, string>(
          data.active
            .filter((a: any) => a.batch_id === batchId)
            .map((a: any) => [a.id, a.status])
        );
        const historyById = new Map<string, string>(
          data.history
            .filter((h: any) => h.batch_id === batchId)
            .map((h: any) => [h.id, h.status])
        );
        setStates((prev) =>
          prev.map((s) => ({
            ...s,
            status: activeById.get(s.id) ?? historyById.get(s.id) ?? s.status,
          }))
        );
      } catch {
        // transient poll failure — keep last known state
      }
    }

    poll();
    const iv = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [token, batchId, jobs.length]);

  const counts = {
    queued: states.filter((s) => s.status === "queued").length,
    running: states.filter((s) => !["queued", "done", "failed", "cancelled"].includes(s.status)).length,
    done: states.filter((s) => s.status === "done").length,
    failed: states.filter((s) => s.status === "failed").length,
    cancelled: states.filter((s) => s.status === "cancelled").length,
  };
  const finished = counts.done + counts.failed + counts.cancelled;
  const total = states.length;
  const allFinished = total > 0 && finished === total;

  useEffect(() => {
    if (allFinished && !doneRef.current) {
      doneRef.current = true;
      setTimeout(() => onDone(), 4000);
    }
  }, [allFinished]);

  const runningJobs = states.filter(
    (s) => !["queued", "done", "failed", "cancelled"].includes(s.status)
  );

  async function cancelRemaining() {
    setCancelling(true);
    const queued = states.filter((s) => s.status === "queued");
    for (const s of queued) {
      await cancelJob(token, s.id);
    }
    setCancelling(false);
  }

  function statusBadge(status: string) {
    if (status === "done") return <Badge variant="success">done</Badge>;
    if (status === "failed") return <Badge variant="destructive">failed</Badge>;
    if (status === "cancelled") return <Badge variant="secondary">cancelled</Badge>;
    if (status === "queued") return <Badge variant="warning">queued</Badge>;
    return <Badge variant="default">{status}</Badge>;
  }

  return (
    <Card className="mb-3">
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <ListVideo className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium truncate" title={batchLabel}>{batchLabel}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">{finished}/{total}</span>
            {counts.queued > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={cancelRemaining}
                disabled={cancelling}
              >
                <X className="h-3 w-3" />
                Cancel remaining
              </Button>
            )}
          </div>
        </div>

        <Progress value={total ? (finished / total) * 100 : 0} className="mb-1.5" />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{mountName}</span>
          <span className="flex gap-3">
            {counts.running > 0 && <span>▶ {counts.running} running</span>}
            {counts.queued > 0 && <span>{counts.queued} queued</span>}
            {counts.done > 0 && <span className="text-green-500">✓ {counts.done}</span>}
            {counts.failed > 0 && <span className="text-destructive">✗ {counts.failed}</span>}
            {counts.cancelled > 0 && <span>{counts.cancelled} cancelled</span>}
            {skippedCount > 0 && <span>{skippedCount} skipped</span>}
          </span>
        </div>

        {/* Live cards only for currently-running jobs (bounded by max_concurrent_jobs) */}
        {runningJobs.length > 0 && (
          <div className="mt-3">
            {runningJobs.map((s) => (
              <JobProgress
                key={s.id}
                token={token}
                jobId={s.id}
                source={s.filename}
                type="url"
                mountName={mountName}
                initialStatus={s.status}
              />
            ))}
          </div>
        )}

        {/* Expandable full list */}
        <button
          type="button"
          className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {expanded ? "Hide" : "Show"} all {total} episodes
        </button>
        {expanded && (
          <ul className="mt-2 max-h-64 overflow-y-auto space-y-1">
            {states.map((s) => (
              <li key={s.id} className={cn("flex items-center justify-between gap-2 text-xs", s.status === "queued" && "text-muted-foreground")}>
                <span className="truncate" title={s.filename}>{s.filename}</span>
                {statusBadge(s.status)}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
