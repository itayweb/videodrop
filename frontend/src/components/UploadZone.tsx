import { useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { uploadFile } from "@/lib/api";
import { Button } from "./ui/button";
import { MountPicker } from "./MountPicker";
import { cn } from "@/lib/utils";

interface Mount {
  name: string;
  path: string;
}

interface Props {
  token: string;
  mounts: Mount[];
  onJobCreated: (jobId: string, source: string, mountName: string) => void;
}

export function UploadZone({ token, mounts, onJobCreated }: Props) {
  const [mount, setMount] = useState(mounts[0]?.name ?? "");
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  }

  async function handleUpload() {
    if (!file || !mount) return;
    setError("");
    setUploading(true);
    setPct(0);
    try {
      const jobId = await uploadFile(token, file, mount, setPct);
      onJobCreated(jobId, file.name, mount);
      setFile(null);
      setPct(0);
    } catch (err: any) {
      setError(err.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors",
          dragging ? "border-primary bg-accent" : "border-border hover:border-primary/50"
        )}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <UploadCloud className="mx-auto h-8 w-8 mb-2 text-muted-foreground" />
        {file ? (
          <p className="text-sm font-medium">{file.name} <span className="text-muted-foreground">({(file.size / 1e9).toFixed(2)} GB)</span></p>
        ) : (
          <>
            <p className="text-sm font-medium">Drop video here or click to browse</p>
            <p className="text-xs text-muted-foreground mt-1">Up to 10 GB</p>
          </>
        )}
        <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <MountPicker mounts={mounts} value={mount} onChange={setMount} />
        </div>
        <Button onClick={handleUpload} disabled={!file || !mount || uploading}>
          <UploadCloud className="h-4 w-4" />
          {uploading ? `${pct}%` : "Upload"}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
