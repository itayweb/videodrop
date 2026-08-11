const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB

export interface Mount {
  name: string;
  path: string;
  /** null when the mount isn't reachable */
  free_bytes: number | null;
}

export interface SonarrResult {
  tvdbId: number;
  title: string;
  year: number;
  overview: string;
  inSonarr: boolean;
  /** Series folder, only set once the series is in Sonarr — tells us its drive */
  path: string | null;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** FastAPI wraps HTTPException messages in {detail}; show that rather than raw JSON. */
async function toError(res: Response): Promise<Error> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.detail === "string") return new Error(parsed.detail);
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return new Error(body || res.statusText);
}

export async function fetchConfig(token: string) {
  const res = await fetch("/api/config", { headers: authHeader(token) });
  if (!res.ok) throw new Error("Unauthorized");
  return res.json() as Promise<{ mounts: Mount[] }>;
}

export async function submitUrl(
  token: string,
  url: string,
  mountName: string,
  filename?: string,
  mediaType: "none" | "tv" | "movie" = "none",
  seriesTvdbId?: number,
  seriesTitle?: string,
  seriesYear?: number,
) {
  const res = await fetch("/api/jobs/url", {
    method: "POST",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      mount_name: mountName,
      filename: filename?.trim() || null,
      media_type: mediaType,
      series_tvdb_id: seriesTvdbId ?? null,
      series_title: seriesTitle ?? null,
      series_year: seriesYear ?? null,
    }),
  });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<{ job_id: string }>;
}

export interface PlaylistEntry {
  index: number;
  video_id: string;
  video_url: string;
  orig_title: string;
  translated_title: string;
  translated: boolean;
  episode_number: number | null;
  season_number: number | null;
  unavailable: boolean;
}

export interface PlaylistPreview {
  playlist_title: string;
  playlist_title_translated: string;
  suggested_season: number;
  entries: PlaylistEntry[];
  truncated: boolean;
}

export interface PlaylistConfirmPayload {
  mount_name: string;
  media_type: "none" | "tv";
  show_name: string;
  series_tvdb_id?: number | null;
  series_title?: string | null;
  series_year?: number | null;
  entries: { video_url: string; season: number; episode_number: number; title: string }[];
}

export interface PlaylistConfirmResult {
  batch_id: string;
  batch_label: string;
  jobs: { job_id: string; filename: string; video_url: string }[];
  skipped: { video_url: string; filename: string }[];
}

export async function fetchPlaylistPreview(token: string, url: string): Promise<PlaylistPreview> {
  const res = await fetch("/api/playlist/preview", {
    method: "POST",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? (await res.text()));
  }
  return res.json();
}

export async function confirmPlaylist(token: string, payload: PlaylistConfirmPayload): Promise<PlaylistConfirmResult> {
  const res = await fetch("/api/playlist/confirm", {
    method: "POST",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? (await res.text()));
  }
  return res.json();
}

export interface TelegramChannelEntry {
  msg_id: number;
  date: string;
  orig_caption: string;
  translated_caption: string;
  translated: boolean;
  duration: number | null;
  file_size: number | null;
  episode_number: number | null;
  season_number: number | null;
  already_downloaded: boolean;
}

export interface TelegramChannelPreview {
  channel_title: string;
  channel_title_translated: string;
  channel_username: string | null;
  channel_id: number;
  suggested_season: number;
  entries: TelegramChannelEntry[];
  truncated: boolean;
}

export interface TelegramChannelConfirmPayload {
  chat: string;
  mount_name: string;
  dest_mode: "episodes" | "raw";
  media_type: "none" | "tv";
  show_name?: string | null;
  series_tvdb_id?: number | null;
  series_title?: string | null;
  series_year?: number | null;
  entries: {
    msg_id: number;
    date: string;
    season?: number | null;
    episode_number?: number | null;
    title: string;
  }[];
}

export interface TelegramChannelConfirmResult {
  batch_id: string;
  batch_label: string;
  jobs: { job_id: string; filename: string; msg_id: number }[];
  skipped: { msg_id: number; filename: string }[];
}

export async function fetchTelegramChannelPreview(token: string, chat: string): Promise<TelegramChannelPreview> {
  const res = await fetch("/api/telegram/channel/preview", {
    method: "POST",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({ chat }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? (await res.text()));
  }
  return res.json();
}

export async function confirmTelegramChannel(
  token: string,
  payload: TelegramChannelConfirmPayload
): Promise<TelegramChannelConfirmResult> {
  const res = await fetch("/api/telegram/channel/confirm", {
    method: "POST",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? (await res.text()));
  }
  return res.json();
}

export interface DailymotionEntry {
  video_id: string;
  upload_date: string | null;      // "YYYYMMDD" from yt-dlp, or null
  orig_title: string;
  translated_title: string;
  translated: boolean;
  duration: number | null;
  episode_number: number | null;
  season_number: number | null;
  already_downloaded: boolean;
  unavailable: boolean;
}

export interface DailymotionPreview {
  channel_name: string;
  channel_title: string;
  channel_title_translated: string;
  suggested_season: number;
  entries: DailymotionEntry[];
  truncated: boolean;
}

export interface DailymotionConfirmPayload {
  channel_name: string;
  mount_name: string;
  dest_mode: "episodes" | "raw";
  media_type: "none" | "tv";
  show_name?: string | null;
  series_tvdb_id?: number | null;
  series_title?: string | null;
  series_year?: number | null;
  entries: {
    video_id: string;
    upload_date: string | null;
    season?: number | null;
    episode_number?: number | null;
    title: string;
  }[];
}

export interface DailymotionConfirmResult {
  batch_id: string;
  batch_label: string;
  jobs: { job_id: string; filename: string; video_id: string }[];
  skipped: { video_id: string; filename: string }[];
}

export async function startDailymotionPreview(
  token: string,
  previewId: string,
  url: string
): Promise<{ preview_id: string }> {
  const res = await fetch("/api/dailymotion/preview/start", {
    method: "POST",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({ preview_id: previewId, url }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? (await res.text()));
  }
  return res.json();
}

export async function confirmDailymotion(
  token: string,
  payload: DailymotionConfirmPayload
): Promise<DailymotionConfirmResult> {
  const res = await fetch("/api/dailymotion/confirm", {
    method: "POST",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? (await res.text()));
  }
  return res.json();
}

export async function searchSonarr(token: string, q: string) {
  const res = await fetch(`/api/sonarr/search?q=${encodeURIComponent(q)}`, {
    headers: authHeader(token),
  });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<SonarrResult[]>;
}

export async function searchRadarr(token: string, q: string) {
  const res = await fetch(`/api/radarr/search?q=${encodeURIComponent(q)}`, {
    headers: authHeader(token),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ tmdbId: number; title: string; year: number; overview: string; inRadarr: boolean }[]>;
}

export async function fetchArrStatus(token: string) {
  const res = await fetch("/api/arr/status", { headers: authHeader(token) });
  if (!res.ok) return { sonarr: false, radarr: false };
  return res.json() as Promise<{ sonarr: boolean; radarr: boolean }>;
}

export async function initUpload(
  token: string,
  filename: string,
  mountName: string,
  totalChunks: number,
  customFilename?: string,
  mediaType: "none" | "tv" | "movie" = "none",
  seriesTvdbId?: number,
  seriesTitle?: string,
  seriesYear?: number
) {
  const params = new URLSearchParams({
    filename,
    mount_name: mountName,
    total_chunks: String(totalChunks),
    media_type: mediaType,
  });
  if (customFilename?.trim()) params.set("custom_filename", customFilename.trim());
  if (seriesTvdbId != null) params.set("series_tvdb_id", String(seriesTvdbId));
  if (seriesTitle) params.set("series_title", seriesTitle);
  if (seriesYear != null) params.set("series_year", String(seriesYear));
  const res = await fetch(`/api/jobs/upload/init?${params}`, {
    method: "POST",
    headers: authHeader(token),
  });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<{ job_id: string }>;
}

const CHUNK_UPLOAD_MAX_ATTEMPTS = 3;
const CHUNK_UPLOAD_RETRY_DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function uploadChunk(
  token: string,
  jobId: string,
  filename: string,
  chunkIndex: number,
  totalChunks: number,
  blob: Blob
) {
  const params = new URLSearchParams({
    job_id: jobId,
    filename,
    chunk_index: String(chunkIndex),
    total_chunks: String(totalChunks),
  });

  let lastError: string = "";
  for (let attempt = 1; attempt <= CHUNK_UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      const form = new FormData();
      form.append("file", blob, filename);
      const res = await fetch(`/api/jobs/upload/chunk?${params}`, {
        method: "POST",
        headers: authHeader(token),
        body: form,
      });
      if (res.ok) return res.json();
      lastError = await res.text();
      if (res.status < 500) break; // don't retry client errors (bad request, auth, etc.)
    } catch (err: any) {
      // Network-level failure (e.g. "TypeError: Failed to fetch") — worth retrying.
      lastError = err?.message ?? String(err);
    }
    if (attempt < CHUNK_UPLOAD_MAX_ATTEMPTS) await sleep(CHUNK_UPLOAD_RETRY_DELAY_MS);
  }
  throw new Error(`Upload failed at chunk ${chunkIndex + 1}/${totalChunks}: ${lastError}`);
}

export async function uploadFile(
  token: string,
  file: File,
  mountName: string,
  onProgress: (pct: number) => void,
  customFilename?: string,
  mediaType: "none" | "tv" | "movie" = "none",
  seriesTvdbId?: number,
  seriesTitle?: string,
  seriesYear?: number
): Promise<string> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const { job_id } = await initUpload(
    token, file.name, mountName, totalChunks, customFilename,
    mediaType, seriesTvdbId, seriesTitle, seriesYear
  );

  for (let i = 0; i < totalChunks; i++) {
    const blob = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await uploadChunk(token, job_id, file.name, i, totalChunks, blob);
    onProgress(Math.round(((i + 1) / totalChunks) * 95));
  }

  return job_id;
}

export async function fetchJobs(token: string, limit = 100) {
  const res = await fetch(`/api/jobs?limit=${limit}`, { headers: authHeader(token) });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<{ active: any[]; history: any[] }>;
}

export interface FullConfig {
  password: string;
  mounts: { name: string; path: string }[];
  max_concurrent_jobs: number;
  max_channel_entries: number;
  telegram: {
    api_id: number | null;
    api_hash: string | null;
    session_file: string;
    bot_token: string | null;
    chat_id: string | null;
  } | null;
  sonarr: { url: string; api_key: string } | null;
  radarr: { url: string; api_key: string } | null;
}

export async function fetchFullConfig(token: string): Promise<FullConfig> {
  const res = await fetch("/api/config/full", { headers: authHeader(token) });
  if (!res.ok) throw await toError(res);
  return res.json();
}

export async function saveConfig(token: string, cfg: FullConfig): Promise<void> {
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { ...authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw await toError(res);
}

export async function cancelJob(token: string, jobId: string) {
  await fetch(`/api/jobs/${jobId}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
}

export function openJobSocket(
  token: string,
  jobId: string,
  onMessage: (data: any) => void,
  onClose?: () => void
): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/${jobId}?token=${token}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = onClose ?? (() => {});
  return ws;
}
