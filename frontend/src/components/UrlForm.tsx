import { useEffect, useState } from "react";
import { Send, Tv, Film, Ban, ListVideo, Youtube } from "lucide-react";
import {
  submitUrl,
  fetchArrStatus,
  fetchPlaylistPreview,
  PlaylistPreview,
  PlaylistConfirmResult,
} from "@/lib/api";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { MountPicker } from "./MountPicker";
import { PlaylistReview } from "./PlaylistReview";
import { SeriesSearch, SonarrResult } from "./SeriesSearch";
import { cn } from "@/lib/utils";

interface Mount { name: string; path: string }

interface Props {
  token: string;
  mounts: Mount[];
  onJobCreated: (jobId: string, source: string, mountName: string, customFileName?: string) => void;
  onBatchCreated: (result: PlaylistConfirmResult, mountName: string) => void;
}

type MediaType = "none" | "tv" | "movie";
type Source = "telegram" | "youtube";

const MEDIA_BUTTONS: { type: MediaType; label: string; Icon: any }[] = [
  { type: "none", label: "None", Icon: Ban },
  { type: "tv",   label: "TV Show", Icon: Tv },
  { type: "movie",label: "Movie", Icon: Film },
];

const SOURCE_BUTTONS: { source: Source; label: string; Icon: any }[] = [
  { source: "telegram", label: "Telegram", Icon: Send },
  { source: "youtube",  label: "YouTube", Icon: Youtube },
];

export function UrlForm({ token, mounts, onJobCreated, onBatchCreated }: Props) {
  const [source, setSource] = useState<Source>("telegram");
  const [playlistMode, setPlaylistMode] = useState(false);
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [mount, setMount] = useState(mounts[0]?.name ?? "");
  const [mediaType, setMediaType] = useState<MediaType>("none");
  const [selectedSeries, setSelectedSeries] = useState<SonarrResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<PlaylistPreview | null>(null);

  // Arr availability
  const [arrStatus, setArrStatus] = useState({ sonarr: false, radarr: false });
  useEffect(() => {
    fetchArrStatus(token).then(setArrStatus);
  }, [token]);

  const isPlaylist = source === "youtube" && playlistMode;

  function handleMediaTypeChange(t: MediaType) {
    setMediaType(t);
    setSelectedSeries(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setError("");
    setNotice("");

    if (isPlaylist) {
      setLoading(true);
      try {
        const p = await fetchPlaylistPreview(token, url.trim());
        setPreview(p);
      } catch (err: any) {
        setError(err.message ?? "Failed to read playlist");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!mount) return;
    if (mediaType === "tv" && !selectedSeries) {
      setError("Please select a TV series from the search results.");
      return;
    }
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
      onJobCreated(job_id, url.trim(), mount, filename || undefined);
      setUrl("");
      setFilename("");
      setSelectedSeries(null);
      setMediaType("none");
    } catch (err: any) {
      setError(err.message ?? "Failed to submit");
    } finally {
      setLoading(false);
    }
  }

  function handleConfirmed(result: PlaylistConfirmResult, mountName: string) {
    setPreview(null);
    setUrl("");
    setPlaylistMode(false);
    const skipped = result.skipped?.length ?? 0;
    if (result.jobs.length === 0) {
      setNotice(`Nothing to download — all ${skipped} episodes already on disk.`);
    } else if (skipped > 0) {
      setNotice(`${result.jobs.length} queued, ${skipped} skipped (already on disk).`);
    } else {
      setNotice("");
    }
    onBatchCreated(result, mountName);
  }

  const canSubmit =
    url.trim() && !loading &&
    (isPlaylist || (mount && (mediaType !== "tv" || !!selectedSeries)));

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* Source toggle */}
      <div className="flex gap-2">
        {SOURCE_BUTTONS.map(({ source: s, label, Icon }) => (
          <button
            key={s}
            type="button"
            disabled={loading}
            onClick={() => {
              setSource(s);
              setError("");
              if (s === "telegram") setPlaylistMode(false);
            }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm transition-colors",
              source === s
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
        {source === "youtube" && (
          <label className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={playlistMode}
              onChange={(e) => setPlaylistMode(e.target.checked)}
              disabled={loading}
            />
            <ListVideo className="h-3.5 w-3.5" />
            Playlist
          </label>
        )}
      </div>

      <Input
        placeholder={
          source === "telegram"
            ? "Paste Telegram video URL…"
            : isPlaylist
              ? "Paste YouTube playlist URL…"
              : "Paste YouTube video URL…"
        }
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={loading}
      />

      {!isPlaylist && (
        <>
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
            <SeriesSearch
              token={token}
              value={selectedSeries}
              onChange={setSelectedSeries}
              disabled={loading}
            />
          )}
        </>
      )}

      <div className="flex gap-2">
        {!isPlaylist && (
          <div className="flex-1">
            <MountPicker mounts={mounts} value={mount} onChange={setMount} />
          </div>
        )}
        <Button type="submit" disabled={!canSubmit} className={cn(isPlaylist && "w-full")}>
          {isPlaylist ? <ListVideo className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          {loading
            ? isPlaylist ? "Fetching playlist…" : "Submitting…"
            : isPlaylist ? "Fetch playlist" : "Download"}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

      {preview && (
        <PlaylistReview
          token={token}
          preview={preview}
          mounts={mounts}
          sonarrAvailable={arrStatus.sonarr}
          onCancel={() => setPreview(null)}
          onConfirmed={handleConfirmed}
        />
      )}
    </form>
  );
}
