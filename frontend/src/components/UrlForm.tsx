import { useEffect, useState } from "react";
import { Send, Tv, Film, Ban, ListVideo, Youtube, Users, Clapperboard } from "lucide-react";
import {
  submitUrl,
  fetchArrStatus,
  fetchPlaylistPreview,
  fetchTelegramChannelPreview,
  startDailymotionPreview,
  openJobSocket,
  PlaylistPreview,
  PlaylistConfirmResult,
  TelegramChannelPreview,
  TelegramChannelConfirmResult,
  DailymotionPreview,
  DailymotionConfirmResult,
} from "@/lib/api";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { MountPicker } from "./MountPicker";
import { PlaylistReview } from "./PlaylistReview";
import { TelegramChannelReview } from "./TelegramChannelReview";
import { DailyMotionReview } from "./DailyMotionReview";
import { SeriesSearch, SonarrResult } from "./SeriesSearch";
import { MovieSearch, RadarrResult } from "./MovieSearch";
import { cn, genId } from "@/lib/utils";

interface Mount { name: string; path: string }

interface Props {
  token: string;
  mounts: Mount[];
  onJobCreated: (jobId: string, source: string, mountName: string, customFileName?: string) => void;
  onBatchCreated: (result: PlaylistConfirmResult | TelegramChannelConfirmResult | DailymotionConfirmResult, mountName: string) => void;
}

type MediaType = "none" | "tv" | "movie";
type Source = "telegram" | "youtube" | "dailymotion";

const MEDIA_BUTTONS: { type: MediaType; label: string; Icon: any }[] = [
  { type: "none", label: "None", Icon: Ban },
  { type: "tv",   label: "TV Show", Icon: Tv },
  { type: "movie",label: "Movie", Icon: Film },
];

const SOURCE_BUTTONS: { source: Source; label: string; Icon: any }[] = [
  { source: "telegram", label: "Telegram", Icon: Send },
  { source: "youtube",  label: "YouTube", Icon: Youtube },
  { source: "dailymotion", label: "DailyMotion", Icon: Clapperboard },
];

export function UrlForm({ token, mounts, onJobCreated, onBatchCreated }: Props) {
  const [source, setSource] = useState<Source>("telegram");
  const [playlistMode, setPlaylistMode] = useState(false);
  const [channelMode, setChannelMode] = useState(false);
  const [dailymotionBulkMode, setDailymotionBulkMode] = useState(false);
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [mount, setMount] = useState(mounts[0]?.name ?? "");
  const [mediaType, setMediaType] = useState<MediaType>("none");
  const [selectedSeries, setSelectedSeries] = useState<SonarrResult | null>(null);
  const [selectedMovie, setSelectedMovie] = useState<RadarrResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<PlaylistPreview | null>(null);
  const [channelPreview, setChannelPreview] = useState<TelegramChannelPreview | null>(null);
  const [dailymotionPreview, setDailymotionPreview] = useState<DailymotionPreview | null>(null);
  const [dailymotionProgress, setDailymotionProgress] = useState<{ fetched: number; total: number } | null>(null);

  // Arr availability
  const [arrStatus, setArrStatus] = useState({ sonarr: false, radarr: false });
  useEffect(() => {
    fetchArrStatus(token).then(setArrStatus);
  }, [token]);

  const isPlaylist = source === "youtube" && playlistMode;
  const isChannel = source === "telegram" && channelMode;
  const isDailymotionBulk = source === "dailymotion" && dailymotionBulkMode;

  function handleMediaTypeChange(t: MediaType) {
    setMediaType(t);
    setSelectedSeries(null);
    setSelectedMovie(null);
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

    if (isChannel) {
      setLoading(true);
      try {
        const p = await fetchTelegramChannelPreview(token, url.trim());
        setChannelPreview(p);
      } catch (err: any) {
        setError(err.message ?? "Failed to read channel");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (isDailymotionBulk) {
      setLoading(true);
      setDailymotionProgress({ fetched: 0, total: 0 });
      const previewId = genId();
      const ws = openJobSocket(token, previewId, (data: any) => {
        if (data.type === "progress") {
          setDailymotionProgress({ fetched: data.fetched, total: data.total });
        } else if (data.type === "done") {
          setDailymotionPreview(data.preview);
          setDailymotionProgress(null);
          setLoading(false);
          ws.close();
        } else if (data.type === "error") {
          setError(data.message ?? "Failed to read channel");
          setDailymotionProgress(null);
          setLoading(false);
          ws.close();
        }
      });
      try {
        await startDailymotionPreview(token, previewId, url.trim());
      } catch (err: any) {
        setError(err.message ?? "Failed to read channel");
        setDailymotionProgress(null);
        setLoading(false);
        ws.close();
      }
      return;
    }

    if (!mount) return;
    if (mediaType === "tv" && !selectedSeries) {
      setError("Please select a TV series from the search results.");
      return;
    }
    if (mediaType === "movie" && !selectedMovie) {
      setError("Please select a movie from the search results.");
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
      setSelectedMovie(null);
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

  function handleChannelConfirmed(result: TelegramChannelConfirmResult, mountName: string) {
    setChannelPreview(null);
    setUrl("");
    setChannelMode(false);
    const skipped = result.skipped?.length ?? 0;
    if (result.jobs.length === 0) {
      setNotice(`Nothing to download — all ${skipped} videos already downloaded.`);
    } else if (skipped > 0) {
      setNotice(`${result.jobs.length} queued, ${skipped} skipped (already downloaded).`);
    } else {
      setNotice("");
    }
    onBatchCreated(result, mountName);
  }

  function handleDailymotionConfirmed(result: DailymotionConfirmResult, mountName: string) {
    setDailymotionPreview(null);
    setUrl("");
    setDailymotionBulkMode(false);
    const skipped = result.skipped?.length ?? 0;
    if (result.jobs.length === 0) {
      setNotice(`Nothing to download — all ${skipped} videos already downloaded.`);
    } else if (skipped > 0) {
      setNotice(`${result.jobs.length} queued, ${skipped} skipped (already downloaded).`);
    } else {
      setNotice("");
    }
    onBatchCreated(result, mountName);
  }

  const canSubmit =
    url.trim() && !loading &&
    (isPlaylist || isChannel || isDailymotionBulk || (mount && (mediaType !== "tv" || !!selectedSeries) && (mediaType !== "movie" || !!selectedMovie)));

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
              if (s !== "youtube") setPlaylistMode(false);
              if (s !== "telegram") setChannelMode(false);
              if (s !== "dailymotion") setDailymotionBulkMode(false);
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
        {source === "telegram" && (
          <label className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={channelMode}
              onChange={(e) => setChannelMode(e.target.checked)}
              disabled={loading}
            />
            <Users className="h-3.5 w-3.5" />
            Channel/Group
          </label>
        )}
        {source === "dailymotion" && (
          <label className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dailymotionBulkMode}
              onChange={(e) => setDailymotionBulkMode(e.target.checked)}
              disabled={loading}
            />
            <Users className="h-3.5 w-3.5" />
            Channel (bulk)
          </label>
        )}
      </div>

      <Input
        placeholder={
          source === "telegram"
            ? isChannel
              ? "Paste channel/group username or t.me link…"
              : "Paste Telegram video URL…"
            : source === "youtube"
              ? isPlaylist
                ? "Paste YouTube playlist URL…"
                : "Paste YouTube video URL…"
              : isDailymotionBulk
                ? "Paste DailyMotion user/channel URL…"
                : "Paste DailyMotion video URL…"
        }
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={loading}
      />

      {isDailymotionBulk && dailymotionProgress && (
        <p className="text-xs text-muted-foreground">
          Fetching metadata… {dailymotionProgress.fetched}/{dailymotionProgress.total || "?"}
        </p>
      )}

      {!isPlaylist && !isChannel && !isDailymotionBulk && (
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

          {/* Radarr movie search */}
          {mediaType === "movie" && (
            <MovieSearch
              token={token}
              value={selectedMovie}
              onChange={setSelectedMovie}
              disabled={loading}
            />
          )}
        </>
      )}

      <div className="flex gap-2">
        {!isPlaylist && !isChannel && !isDailymotionBulk && (
          <div className="flex-1">
            <MountPicker mounts={mounts} value={mount} onChange={setMount} />
          </div>
        )}
        <Button type="submit" disabled={!canSubmit} className={cn((isPlaylist || isChannel || isDailymotionBulk) && "w-full")}>
          {isPlaylist || isChannel || isDailymotionBulk ? <ListVideo className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          {loading
            ? isPlaylist ? "Fetching playlist…" : isChannel ? "Fetching channel…" : isDailymotionBulk ? "Fetching channel…" : "Submitting…"
            : isPlaylist ? "Fetch playlist" : isChannel ? "Fetch channel" : isDailymotionBulk ? "Fetch channel" : "Download"}
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

      {dailymotionPreview && (
        <DailyMotionReview
          token={token}
          channelName={dailymotionPreview.channel_name}
          preview={dailymotionPreview}
          mounts={mounts}
          sonarrAvailable={arrStatus.sonarr}
          onCancel={() => setDailymotionPreview(null)}
          onConfirmed={handleDailymotionConfirmed}
        />
      )}

      {channelPreview && (
        <TelegramChannelReview
          token={token}
          chat={url.trim()}
          preview={channelPreview}
          mounts={mounts}
          sonarrAvailable={arrStatus.sonarr}
          onCancel={() => setChannelPreview(null)}
          onConfirmed={handleChannelConfirmed}
        />
      )}
    </form>
  );
}
