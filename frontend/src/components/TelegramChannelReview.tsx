import { useMemo, useState } from "react";
import { AlertTriangle, Download, Tv, Ban, X, FileText, ListVideo } from "lucide-react";
import {
  TelegramChannelPreview,
  TelegramChannelConfirmResult,
  confirmTelegramChannel,
} from "@/lib/api";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { MountPicker } from "./MountPicker";
import { SeriesSearch, SonarrResult } from "./SeriesSearch";
import { cn } from "@/lib/utils";
import type { Mount } from "@/lib/api";

type DestMode = "raw" | "episodes";

interface EntryRow {
  selected: boolean;
  msgId: number;
  date: string;
  origCaption: string;
  title: string;
  season: string;  // keep as text for free editing; validated on confirm
  episode: string;
  duration: number | null;
  fileSize: number | null;
  alreadyDownloaded: boolean;
  translated: boolean;
}

interface Props {
  token: string;
  chat: string;
  preview: TelegramChannelPreview;
  mounts: Mount[];
  sonarrAvailable: boolean;
  onCancel: () => void;
  onConfirmed: (result: TelegramChannelConfirmResult, mountName: string) => void;
}

function formatDuration(sec: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TelegramChannelReview({ token, chat, preview, mounts, sonarrAvailable, onCancel, onConfirmed }: Props) {
  const [destMode, setDestMode] = useState<DestMode>("raw");
  const [rows, setRows] = useState<EntryRow[]>(() =>
    preview.entries.map((e) => ({
      selected: !e.already_downloaded,
      msgId: e.msg_id,
      date: e.date,
      origCaption: e.orig_caption,
      title: e.translated_caption,
      season: e.season_number != null ? String(e.season_number) : "",
      episode: e.episode_number != null ? String(e.episode_number) : "",
      duration: e.duration,
      fileSize: e.file_size,
      alreadyDownloaded: e.already_downloaded,
      translated: e.translated,
    }))
  );
  const [showName, setShowName] = useState(preview.channel_title_translated ?? "");
  const [defaultSeason, setDefaultSeason] = useState(String(preview.suggested_season));
  const [mediaType, setMediaType] = useState<"none" | "tv">("none");
  const [series, setSeries] = useState<SonarrResult | null>(null);
  const [mount, setMount] = useState(mounts[0]?.name ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function updateRow(i: number, patch: Partial<EntryRow>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function pickSeries(s: SonarrResult | null) {
    setSeries(s);
    if (s) setShowName(s.title);
  }

  // Rows without their own season fall back to the default-season field
  function effectiveSeason(r: EntryRow): number {
    const own = parseInt(r.season, 10);
    if (r.season.trim() && !isNaN(own)) return own;
    return parseInt(defaultSeason, 10);
  }

  const selectedRows = rows.filter((r) => r.selected);

  const duplicateKeys = useMemo(() => {
    if (destMode !== "episodes") return new Set<string>();
    const seen = new Map<string, number>();
    for (const r of selectedRows) {
      const s = effectiveSeason(r);
      const ep = parseInt(r.episode, 10);
      if (isNaN(s) || isNaN(ep)) continue;
      const key = `${s}-${ep}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  }, [rows, defaultSeason, destMode]);

  function rowKey(r: EntryRow): string {
    return `${effectiveSeason(r)}-${parseInt(r.episode, 10)}`;
  }

  const problems: string[] = [];
  if (selectedRows.length === 0) problems.push("Select at least one video.");
  if (!mount) problems.push("Pick a destination mount.");
  if (destMode === "episodes") {
    if (selectedRows.some((r) => !r.episode.trim() || isNaN(parseInt(r.episode, 10))))
      problems.push("Every selected video needs an episode number.");
    if (selectedRows.some((r) => isNaN(effectiveSeason(r)) || effectiveSeason(r) < 0))
      problems.push("Every selected video needs a season (set it in the row or in Default season).");
    if (duplicateKeys.size > 0) problems.push("Season + episode pairs must be unique.");
    if (!showName.trim()) problems.push("Show name is required.");
    if (mediaType === "tv" && !series) problems.push("Select a series for Sonarr import.");
  }

  const canConfirm = problems.length === 0 && !submitting;

  function filenamePreview(r: EntryRow): string {
    if (destMode === "episodes") {
      const ep = parseInt(r.episode, 10);
      const s = effectiveSeason(r);
      if (!showName.trim() || isNaN(ep) || isNaN(s)) return "";
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${showName.trim()} - S${pad(s)}E${pad(ep)} - ${r.title}.mp4`;
    }
    const datePart = r.date.slice(0, 10);
    const base = `${datePart} - ${r.msgId}`;
    return (r.title.trim() ? `${base} - ${r.title.trim()}` : base) + ".mp4";
  }

  async function handleConfirm() {
    setError("");
    setSubmitting(true);
    try {
      const result = await confirmTelegramChannel(token, {
        chat,
        mount_name: mount,
        dest_mode: destMode,
        media_type: destMode === "episodes" ? mediaType : "none",
        show_name: destMode === "episodes" ? showName.trim() : null,
        series_tvdb_id: destMode === "episodes" ? series?.tvdbId ?? null : null,
        series_title: destMode === "episodes" ? series?.title ?? null : null,
        series_year: destMode === "episodes" ? series?.year ?? null : null,
        entries: selectedRows.map((r) => ({
          msg_id: r.msgId,
          date: r.date,
          season: destMode === "episodes" ? effectiveSeason(r) : null,
          episode_number: destMode === "episodes" ? parseInt(r.episode, 10) : null,
          title: r.title.trim(),
        })),
      });
      onConfirmed(result, mount);
    } catch (err: any) {
      setError(err.message ?? "Failed to start downloads");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-lg border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate">{preview.channel_title_translated}</h2>
            <p className="text-xs text-muted-foreground truncate" dir="rtl">{preview.channel_title}</p>
            {preview.truncated && (
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
                Showing first {preview.entries.length} videos — channel may contain more.
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Batch settings */}
        <div className="px-5 py-3 space-y-3 border-b border-border">
          <div className="flex gap-2">
            {([
              { type: "raw" as const, label: "Raw dump", Icon: FileText },
              { type: "episodes" as const, label: "TV episodes", Icon: ListVideo },
            ]).map(({ type, label, Icon }) => (
              <button
                key={type}
                type="button"
                disabled={submitting}
                onClick={() => setDestMode(type)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm transition-colors",
                  destMode === type
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {destMode === "episodes" && (
            <>
              <div className="flex gap-2">
                {([
                  { type: "none" as const, label: "No import", Icon: Ban, disabled: false },
                  { type: "tv" as const, label: "TV Show (Sonarr)", Icon: Tv, disabled: !sonarrAvailable },
                ]).map(({ type, label, Icon, disabled }) => (
                  <button
                    key={type}
                    type="button"
                    disabled={disabled || submitting}
                    onClick={() => setMediaType(type)}
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
                ))}
              </div>

              {mediaType === "tv" && (
                <SeriesSearch token={token} value={series} onChange={pickSeries} disabled={submitting} />
              )}

              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    placeholder="Show name (used in folder and file names)"
                    value={showName}
                    onChange={(e) => setShowName(e.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div className="w-32">
                  <Input
                    type="number"
                    min={0}
                    placeholder="Default season"
                    title="Season used for rows without their own season"
                    value={defaultSeason}
                    onChange={(e) => setDefaultSeason(e.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div className="flex-1">
                  <MountPicker mounts={mounts} value={mount} onChange={setMount} />
                </div>
              </div>
            </>
          )}

          {destMode === "raw" && (
            <div className="flex-1">
              <MountPicker mounts={mounts} value={mount} onChange={setMount} />
            </div>
          )}
        </div>

        {/* Entries table */}
        <div className="flex-1 overflow-y-auto px-5 py-2">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-2 pr-2 font-medium w-8">
                  <input
                    type="checkbox"
                    checked={rows.every((r) => r.selected || r.alreadyDownloaded)}
                    onChange={(e) =>
                      setRows((prev) => prev.map((r) => (r.alreadyDownloaded ? r : { ...r, selected: e.target.checked })))
                    }
                    disabled={submitting}
                  />
                </th>
                {destMode === "episodes" && (
                  <>
                    <th className="py-2 pr-2 font-medium w-16">Season</th>
                    <th className="py-2 pr-2 font-medium w-16">Ep #</th>
                  </>
                )}
                {destMode === "raw" && <th className="py-2 pr-2 font-medium w-24">Date</th>}
                <th className="py-2 pr-2 font-medium w-16">Len</th>
                <th className="py-2 pr-2 font-medium w-20">Size</th>
                <th className="py-2 pr-2 font-medium">Caption (English)</th>
                <th className="py-2 font-medium">Original</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const epMissing = destMode === "episodes" && r.selected && (!r.episode.trim() || isNaN(parseInt(r.episode, 10)));
                const seasonMissing = destMode === "episodes" && r.selected && isNaN(effectiveSeason(r));
                const isDuplicate = destMode === "episodes" && r.selected && !epMissing && !seasonMissing && duplicateKeys.has(rowKey(r));
                return (
                  <tr
                    key={r.msgId}
                    className={cn(
                      "border-b border-border/50 align-top",
                      (r.alreadyDownloaded || !r.selected) && "opacity-50"
                    )}
                  >
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={r.selected}
                        onChange={(e) => updateRow(i, { selected: e.target.checked })}
                        disabled={r.alreadyDownloaded || submitting}
                      />
                    </td>
                    {destMode === "episodes" && (
                      <>
                        <td className="py-2 pr-2">
                          <Input
                            type="number"
                            min={0}
                            value={r.season}
                            placeholder={defaultSeason}
                            onChange={(e) => updateRow(i, { season: e.target.value })}
                            disabled={r.alreadyDownloaded || !r.selected || submitting}
                            className={cn(
                              "h-8 w-16 px-2",
                              (seasonMissing || isDuplicate) && "border-destructive"
                            )}
                          />
                        </td>
                        <td className="py-2 pr-2">
                          <Input
                            type="number"
                            min={0}
                            value={r.episode}
                            onChange={(e) => updateRow(i, { episode: e.target.value })}
                            disabled={r.alreadyDownloaded || !r.selected || submitting}
                            className={cn(
                              "h-8 w-16 px-2",
                              (epMissing || isDuplicate) && "border-destructive"
                            )}
                          />
                          {(epMissing || seasonMissing || isDuplicate) && (
                            <span title={isDuplicate ? "Duplicate season + episode" : epMissing ? "Episode number required" : "Season required"}>
                              <AlertTriangle className="h-3.5 w-3.5 text-destructive mt-1" />
                            </span>
                          )}
                        </td>
                      </>
                    )}
                    {destMode === "raw" && (
                      <td className="py-2 pr-2 text-xs text-muted-foreground whitespace-nowrap">{r.date.slice(0, 10)}</td>
                    )}
                    <td className="py-2 pr-2 text-xs text-muted-foreground whitespace-nowrap">{formatDuration(r.duration)}</td>
                    <td className="py-2 pr-2 text-xs text-muted-foreground whitespace-nowrap">{formatSize(r.fileSize)}</td>
                    <td className="py-2 pr-2">
                      {r.alreadyDownloaded ? (
                        <span className="text-muted-foreground italic">{r.origCaption || "(no caption)"}</span>
                      ) : (
                        <>
                          <Input
                            value={r.title}
                            onChange={(e) => updateRow(i, { title: e.target.value })}
                            disabled={!r.selected || submitting}
                            className="h-8 px-2"
                          />
                          <div className="flex items-center gap-2 mt-1">
                            {!r.translated && r.origCaption && (
                              <Badge variant="warning" className="text-[10px] px-1 py-0">untranslated</Badge>
                            )}
                            {r.selected && filenamePreview(r) && (
                              <span className="text-[10px] text-muted-foreground truncate">{filenamePreview(r)}</span>
                            )}
                          </div>
                        </>
                      )}
                      {r.alreadyDownloaded && (
                        <Badge variant="secondary" className="text-[10px] px-1 py-0 mt-1">already downloaded</Badge>
                      )}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground max-w-[180px]">
                      <span dir="rtl" className="block truncate" title={r.origCaption}>{r.origCaption}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border space-y-2">
          {(error || problems.length > 0) && (
            <p className="text-xs text-destructive">{error || problems[0]}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={!canConfirm}>
              <Download className="h-4 w-4" />
              {submitting
                ? "Starting…"
                : `Download ${selectedRows.length} video${selectedRows.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
