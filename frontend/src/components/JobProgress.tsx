import { useEffect, useRef, useState } from "react";
import { X, Download, Upload } from "lucide-react";
import { openJobSocket, cancelJob } from "@/lib/api";
import { Progress } from "./ui/progress";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";

interface ProgressMsg {
  status: string;
  pct: number;
  speed?: string;
  eta?: string;
  error?: string;
}

interface Props {
  token: string;
  jobId: string;
  source: string;
  type: "url" | "upload";
  mountName: string;
  initialStatus?: string;
  onDone?: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  downloading: "Downloading",
  uploading: "Uploading",
  processing: "Processing",
  assembling: "Assembling",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function statusVariant(s: string): "default" | "success" | "destructive" | "warning" | "secondary" {
  if (s === "done") return "success";
  if (s === "failed") return "destructive";
  if (s === "cancelled") return "secondary";
  if (s === "queued") return "warning";
  return "default";
}

export function JobProgress({ token, jobId, source, type, mountName, initialStatus = "queued", onDone }: Props) {
  const [msg, setMsg] = useState<ProgressMsg>({ status: initialStatus, pct: 0 });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = openJobSocket(token, jobId, (data: ProgressMsg) => {
      setMsg({ ...data, pct: data.pct ?? 0 });
      if (data.status === "done" || data.status === "failed" || data.status === "cancelled") {
        setTimeout(() => onDone?.(), 2000);
      }
    });
    wsRef.current = ws;
    return () => ws.close();
  }, [jobId, token]);

  const isTerminal = ["done", "failed", "cancelled"].includes(msg.status);
  const label = STATUS_LABEL[msg.status] ?? msg.status;
  const shortSource = source.length > 60 ? source.slice(0, 57) + "…" : source;

  return (
    <Card className="mb-3">
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            {type === "url" ? <Download className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <span className="text-sm truncate" title={source}>{shortSource}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant={statusVariant(msg.status)}>{label}</Badge>
            {!isTerminal && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => cancelJob(token, jobId)}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>

        <Progress value={msg.pct} className="mb-1.5" />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{mountName}</span>
          <span className="flex gap-3">
            {msg.speed && <span>{msg.speed}</span>}
            {msg.eta && <span>ETA {msg.eta}</span>}
            {!msg.speed && <span>{(msg.pct ?? 0).toFixed(0)}%</span>}
          </span>
        </div>

        {msg.error && (
          <p className="mt-1 text-xs text-destructive">{msg.error}</p>
        )}
      </CardContent>
    </Card>
  );
}
