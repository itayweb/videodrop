import { useEffect, useRef, useState } from "react";
import { UploadCloud, Ban, Tv, Film } from "lucide-react";
import { uploadFile, fetchArrStatus, type Mount } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { MountPicker } from "./MountPicker";
import { SeriesSearch, SonarrResult } from "./SeriesSearch";
import { MovieSearch, RadarrResult } from "./MovieSearch";
import { cn } from "@/lib/utils";

interface Props {
  token: string;
  mounts: Mount[];
  onJobCreated: (jobId: string, source: string, mountName: string) => void;
}

type MediaType = "none" | "tv" | "movie";

const MEDIA_BUTTONS: { type: MediaType; label: string; Icon: any }[] = [
  { type: "none", label: "None", Icon: Ban },
  { type: "tv",   label: "TV Show", Icon: Tv },
  { type: "movie",label: "Movie", Icon: Film },
];

export function UploadZone({ token, mounts, onJobCreated }: Props) {
  const [mount, setMount] = useState(mounts[0]?.name ?? "");
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [customFileName, setCustomFileName] = useState("");
  const [mediaType, setMediaType] = useState<MediaType>("none");
  const [selectedSeries, setSelectedSeries] = useState<SonarrResult | null>(null);
  const [selectedMovie, setSelectedMovie] = useState<RadarrResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const [arrStatus, setArrStatus] = useState({ sonarr: false, radarr: false });
  useEffect(() => {
    fetchArrStatus(token).then(setArrStatus);
  }, [token]);

  function handleMediaTypeChange(t: MediaType) {
    setMediaType(t);
    setSelectedSeries(null);
    setSelectedMovie(null);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  }

  async function handleUpload() {
    if (!file || !mount) return;
    if (mediaType === "tv" && !selectedSeries) {
      setError("Please select a TV series from the search results.");
      return;
    }
    if (mediaType === "movie" && !selectedMovie) {
      setError("Please select a movie from the search results.");
      return;
    }
    setError("");
    setUploading(true);
    setPct(0);
    try {
      const jobId = await uploadFile(
        token, file, mount, setPct, customFileName,
        mediaType, selectedSeries?.tvdbId, selectedSeries?.title, selectedSeries?.year
      );
      onJobCreated(jobId, file.name, mount);
      setFile(null);
      setCustomFileName("");
      setMediaType("none");
      setSelectedSeries(null);
      setSelectedMovie(null);
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

      <Input
        placeholder="Custom filename (optional, without extension)"
        value={customFileName}
        onChange={(e) => setCustomFileName(e.target.value)}
        disabled={uploading}
      />

      {/* Media type toggle */}
      <div className="flex gap-2">
        {MEDIA_BUTTONS.map(({ type, label, Icon }) => {
          const disabled =
            (type === "tv" && !arrStatus.sonarr) ||
            (type === "movie" && !arrStatus.radarr);
          return (
            <button
              key={type}
              type="button"
              disabled={disabled}
              onClick={() => handleMediaTypeChange(type)}
              title={disabled ? `${label} — not configured in config.yaml` : label}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm transition-colors",
                mediaType === type
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground",
                disabled && "opacity-40 cursor-not-allowed"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Sonarr series search */}
      {mediaType === "tv" && (
        <SeriesSearch
          token={token}
          value={selectedSeries}
          onChange={setSelectedSeries}
          disabled={uploading}
        />
      )}

      {/* Radarr movie search */}
      {mediaType === "movie" && (
        <MovieSearch
          token={token}
          value={selectedMovie}
          onChange={setSelectedMovie}
          disabled={uploading}
        />
      )}

      <div className="flex gap-2">
        <div className="flex-1">
          <MountPicker mounts={mounts} value={mount} onChange={setMount} />
        </div>
        <Button
          onClick={handleUpload}
          disabled={!file || !mount || uploading || (mediaType === "tv" && !selectedSeries) || (mediaType === "movie" && !selectedMovie)}
        >
          <UploadCloud className="h-4 w-4" />
          {uploading ? `${pct}%` : "Upload"}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
