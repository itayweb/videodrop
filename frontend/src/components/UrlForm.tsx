import { useState } from "react";
import { Send } from "lucide-react";
import { submitUrl } from "@/lib/api";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { MountPicker } from "./MountPicker";

interface Mount {
  name: string;
  path: string;
}

interface Props {
  token: string;
  mounts: Mount[];
  onJobCreated: (jobId: string, source: string, mountName: string) => void;
}

export function UrlForm({ token, mounts, onJobCreated }: Props) {
  const [url, setUrl] = useState("");
  const [mount, setMount] = useState(mounts[0]?.name ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || !mount) return;
    setError("");
    setLoading(true);
    try {
      const { job_id } = await submitUrl(token, url.trim(), mount);
      onJobCreated(job_id, url.trim(), mount);
      setUrl("");
    } catch (err: any) {
      setError(err.message ?? "Failed to submit");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Input
        placeholder="Paste Telegram video URL…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={loading}
      />
      <div className="flex gap-2">
        <div className="flex-1">
          <MountPicker mounts={mounts} value={mount} onChange={setMount} />
        </div>
        <Button type="submit" disabled={loading || !url.trim() || !mount}>
          <Send className="h-4 w-4" />
          {loading ? "Submitting…" : "Download"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
