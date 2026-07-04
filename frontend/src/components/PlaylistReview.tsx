import { useMemo, useState } from "react";
import { AlertTriangle, Download, Tv, Ban, X } from "lucide-react";
import {
  PlaylistPreview,
  PlaylistConfirmResult,
  confirmPlaylist,
} from "@/lib/api";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { MountPicker } from "./MountPicker";
import { SeriesSearch, SonarrResult } from "./SeriesSearch";
import { cn } from "@/lib/utils";

interface Mount { name: string; path: string }

interface EntryRow {
  selected: boolean;
  videoUrl: string;
  origTitle: string;
  title: string;
  season: string;  // keep as text for free editing; validated on confirm
  episode: string;
  unavailable: boolean;
  translated: boolean;
}

interface Props {
  token: string;
  preview: PlaylistPreview;
  mounts: Mount[];
  sonarrAvailable: boolean;
  onCancel: () => void;
  onConfirmed: (result: PlaylistConfirmResult, mountName: string) => void;
}

export function PlaylistReview({ token, preview, mounts, sonarrAvailable, onCancel, onConfirmed }: Props) {
  const [rows, setRows] = useState<EntryRow[]>(() =>
    preview.entries.map((e) => ({
      selected: !e.unavailable,
      videoUrl: e.video_url,
      origTitle: e.orig_title,
      title: e.translated_title,
      season: e.season_number != null ? String(e.season_number) : "",
      episode: e.episode_number != null ? String(e.episode_number) : "",
      unavailable: e.unavailable,
      translated: e.translated,
    }))
  );
  const [showName, setShowName] = useState(preview.playlist_title_translated ?? "");
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
    const seen = new Map<string, number>();
    for (const r of selectedRows) {
      const s = effectiveSeason(r);
      const ep = parseInt(r.episode, 10);
      if (isNaN(s) || isNaN(ep)) continue;
      const key = `${s}-${ep}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  }, [rows, defaultSeason]);

  function rowKey(r: EntryRow): string {
    return `${effectiveSeason(r)}-${parseInt(r.episode, 10)}`;
  }

  const problems: string[] = [];
  if (selectedRows.length === 0) problems.push("Select at least one video.");
  if (selectedRows.some((r) => !r.episode.trim() || isNaN(parseInt(r.episode, 10))))
    problems.push("Every selected video needs an episode number.");
  if (selectedRows.some((r) => isNaN(effectiveSeason(r)) || effectiveSeason(r) < 0))
    problems.push("Every selected video needs a season (set it in the row or in Default season).");
  if (duplicateKeys.size > 0) problems.push("Season + episode pairs must be unique.");
  if (!showName.trim()) problems.push("Show name is required.");
  if (mediaType === "tv" && !series) problems.push("Select a series for Sonarr import.");
  if (!mount) problems.push("Pick a destination mount.");

  const canConfirm = problems.length === 0 && !submitting;

  function filenamePreview(r: EntryRow): string {
    const ep = parseInt(r.episode, 10);
    const s = effectiveSeason(r);
    if (!showName.trim() || isNaN(ep) || isNaN(s)) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${showName.trim()} - S${pad(s)}E${pad(ep)} - ${r.title}.mp4`;
  }

  async function handleConfirm() {
    setError("");
    setSubmitting(true);
    try {
      const result = await confirmPlaylist(token, {
        mount_name: mount,
        media_type: mediaType,
        show_name: showName.trim(),
        series_tvdb_id: series?.tvdbId ?? null,
        series_title: series?.title ?? null,
        series_year: series?.year ?? null,
        entries: selectedRows.map((r) => ({
          video_url: r.videoUrl,
          season: effectiveSeason(r),
          episode_number: parseInt(r.episode, 10),
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
            <h2 className="text-base font-semibold truncate">{preview.playlist_title_translated}</h2>
            <p className="text-xs text-muted-foreground truncate" dir="rtl">{preview.playlist_title}</p>
            {preview.truncated && (
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
                Showing first {preview.entries.length} videos — playlist may contain more.
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
        </div>

        {/* Entries table */}
        <div className="flex-1 overflow-y-auto px-5 py-2">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-2 pr-2 font-medium w-8">
                  <input
                    type="checkbox"
                    checked={rows.every((r) => r.selected || r.unavailable)}
                    onChange={(e) =>
                      setRows((prev) => prev.map((r) => (r.unavailable ? r : { ...r, selected: e.target.checked })))
                    }
                    disabled={submitting}
                  />
                </th>
                <th className="py-2 pr-2 font-medium w-16">Season</th>
                <th className="py-2 pr-2 font-medium w-16">Ep #</th>
                <th className="py-2 pr-2 font-medium">Title (English)</th>
                <th className="py-2 font-medium">Original</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const epMissing = r.selected && (!r.episode.trim() || isNaN(parseInt(r.episode, 10)));
                const seasonMissing = r.selected && isNaN(effectiveSeason(r));
                const isDuplicate = r.selected && !epMissing && !seasonMissing && duplicateKeys.has(rowKey(r));
                return (
                  <tr
                    key={i}
                    className={cn(
                      "border-b border-border/50 align-top",
                      (r.unavailable || !r.selected) && "opacity-50"
                    )}
                  >
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={r.selected}
                        onChange={(e) => updateRow(i, { selected: e.target.checked })}
                        disabled={r.unavailable || submitting}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <Input
                        type="number"
                        min={0}
                        value={r.season}
                        placeholder={defaultSeason}
                        onChange={(e) => updateRow(i, { season: e.target.value })}
                        disabled={r.unavailable || !r.selected || submitting}
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
                        disabled={r.unavailable || !r.selected || submitting}
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
                    <td className="py-2 pr-2">
                      {r.unavailable ? (
                        <span className="text-muted-foreground italic">{r.origTitle || "Unavailable video"}</span>
                      ) : (
                        <>
                          <Input
                            value={r.title}
                            onChange={(e) => updateRow(i, { title: e.target.value })}
                            disabled={!r.selected || submitting}
                            className="h-8 px-2"
                          />
                          <div className="flex items-center gap-2 mt-1">
                            {!r.translated && (
                              <Badge variant="warning" className="text-[10px] px-1 py-0">untranslated</Badge>
                            )}
                            {r.selected && filenamePreview(r) && (
                              <span className="text-[10px] text-muted-foreground truncate">{filenamePreview(r)}</span>
                            )}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground max-w-[180px]">
                      <span dir="rtl" className="block truncate" title={r.origTitle}>{r.origTitle}</span>
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
