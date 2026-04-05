import { Badge } from "./ui/badge";

interface Job {
  id: string;
  type: string;
  source: string;
  dest_mount: string;
  dest_path: string | null;
  status: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface Props {
  jobs: Job[];
}

function statusVariant(s: string): "default" | "success" | "destructive" | "warning" | "secondary" {
  if (s === "done") return "success";
  if (s === "failed") return "destructive";
  if (s === "cancelled") return "secondary";
  if (s === "queued" || s === "running") return "warning";
  return "default";
}

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function HistoryTable({ jobs }: Props) {
  if (jobs.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-8">No history yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="pb-2 pr-4 font-medium">Source</th>
            <th className="pb-2 pr-4 font-medium">Mount</th>
            <th className="pb-2 pr-4 font-medium">Status</th>
            <th className="pb-2 pr-4 font-medium">Started</th>
            <th className="pb-2 font-medium">Finished</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const short = job.source.length > 50 ? job.source.slice(0, 47) + "…" : job.source;
            return (
              <tr key={job.id} className="border-b border-border/50 hover:bg-accent/30 transition-colors">
                <td className="py-2 pr-4 max-w-xs">
                  <span title={job.source} className="truncate block">{short}</span>
                  {job.error && <span className="text-xs text-destructive block">{job.error}</span>}
                </td>
                <td className="py-2 pr-4 whitespace-nowrap">{job.dest_mount}</td>
                <td className="py-2 pr-4">
                  <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                </td>
                <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground text-xs">{fmt(job.created_at)}</td>
                <td className="py-2 whitespace-nowrap text-muted-foreground text-xs">{fmt(job.finished_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
