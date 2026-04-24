import { useEffect, useRef, useState } from "react";
import { Send, Tv, Film, Ban, CheckCircle } from "lucide-react";
import { submitUrl, searchSonarr, fetchArrStatus } from "@/lib/api";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { MountPicker } from "./MountPicker";
import { cn } from "@/lib/utils";

interface Mount { name: string; path: string }

interface SonarrResult {
  tvdbId: number;
  title: string;
  year: number;
  overview: string;
  inSonarr: boolean;
}

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

export function UrlForm({ token, mounts, onJobCreated }: Props) {
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [mount, setMount] = useState(mounts[0]?.name ?? "");
  const [mediaType, setMediaType] = useState<MediaType>("none");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Sonarr series search
  const [seriesQuery, setSeriesQuery] = useState("");
  const [seriesResults, setSeriesResults] = useState<SonarrResult[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<SonarrResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Arr availability
  const [arrStatus, setArrStatus] = useState({ sonarr: false, radarr: false });
  useEffect(() => {
    fetchArrStatus(token).then(setArrStatus);
  }, [token]);

  // Debounced series search
  useEffect(() => {
    if (mediaType !== "tv" || seriesQuery.length < 2) {
      setSeriesResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchSonarr(token, seriesQuery);
        setSeriesResults(results);
        setShowDropdown(true);
      } catch {
        setSeriesResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [seriesQuery, mediaType, token]);

  function selectSeries(s: SonarrResult) {
    setSelectedSeries(s);
    setSeriesQuery(s.title);
    setShowDropdown(false);
  }

  function handleMediaTypeChange(t: MediaType) {
    setMediaType(t);
    setSelectedSeries(null);
    setSeriesQuery("");
    setSeriesResults([]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || !mount) return;
    if (mediaType === "tv" && !selectedSeries) {
      setError("Please select a TV series from the search results.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const { job_id } = await submitUrl(
        token,
        url.trim(),
        mount,
        filename || undefined,
        mediaType,
        selectedSeries?.tvdbId,
        selectedSeries?.title,
        selectedSeries?.year,
      );
      onJobCreated(job_id, url.trim(), mount);
      setUrl("");
      setFilename("");
      setSelectedSeries(null);
      setSeriesQuery("");
      setMediaType("none");
    } catch (err: any) {
      setError(err.message ?? "Failed to submit");
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = url.trim() && mount && !loading &&
    (mediaType !== "tv" || !!selectedSeries);

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Input
        placeholder="Paste Telegram video URL…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={loading}
      />
      <Input
        placeholder="Custom filename (optional, without extension)"
        value={filename}
        onChange={(e) => setFilename(e.target.value)}
        disabled={loading}
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
        <div className="relative">
          <Input
            placeholder="Search TV series…"
            value={seriesQuery}
            onChange={(e) => {
              setSeriesQuery(e.target.value);
              setSelectedSeries(null);
            }}
            disabled={loading}
            autoComplete="off"
          />
          {searching && (
            <p className="text-xs text-muted-foreground mt-1">Searching Sonarr…</p>
          )}
          {showDropdown && seriesResults.length > 0 && (
            <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg max-h-64 overflow-y-auto">
              {seriesResults.map((s) => (
                <button
                  key={s.tvdbId}
                  type="button"
                  onClick={() => selectSeries(s)}
                  className="w-full flex items-start gap-3 px-3 py-2 text-left hover:bg-accent transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{s.title}</span>
                      <span className="text-xs text-muted-foreground">{s.year}</span>
                      {s.inSonarr && (
                        <Badge variant="success" className="text-[10px] px-1 py-0 flex items-center gap-0.5">
                          <CheckCircle className="h-2.5 w-2.5" /> In Sonarr
                        </Badge>
                      )}
                    </div>
                    {s.overview && (
                      <p className="text-xs text-muted-foreground truncate">{s.overview}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
          {selectedSeries && (
            <p className="text-xs text-muted-foreground mt-1">
              Selected: <span className="text-foreground font-medium">{selectedSeries.title} ({selectedSeries.year})</span>
              {!selectedSeries.inSonarr && <span className="text-yellow-400 ml-2">— will be added to Sonarr</span>}
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <div className="flex-1">
          <MountPicker mounts={mounts} value={mount} onChange={setMount} />
        </div>
        <Button type="submit" disabled={!canSubmit}>
          <Send className="h-4 w-4" />
          {loading ? "Submitting…" : "Download"}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
