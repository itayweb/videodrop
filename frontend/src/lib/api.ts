const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export async function fetchConfig(token: string) {
  const res = await fetch("/api/config", { headers: authHeader(token) });
  if (!res.ok) throw new Error("Unauthorized");
  return res.json() as Promise<{ mounts: { name: string; path: string }[] }>;
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
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ job_id: string }>;
}

export async function searchSonarr(token: string, q: string) {
  const res = await fetch(`/api/sonarr/search?q=${encodeURIComponent(q)}`, {
    headers: authHeader(token),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ tvdbId: number; title: string; year: number; overview: string; inSonarr: boolean }[]>;
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
  totalChunks: number
) {
  const params = new URLSearchParams({
    filename,
    mount_name: mountName,
    total_chunks: String(totalChunks),
  });
  const res = await fetch(`/api/jobs/upload/init?${params}`, {
    method: "POST",
    headers: authHeader(token),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ job_id: string }>;
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
  const form = new FormData();
  form.append("file", blob, filename);
  const res = await fetch(`/api/jobs/upload/chunk?${params}`, {
    method: "POST",
    headers: authHeader(token),
    body: form,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function uploadFile(
  token: string,
  file: File,
  mountName: string,
  onProgress: (pct: number) => void
): Promise<string> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const { job_id } = await initUpload(token, file.name, mountName, totalChunks);

  for (let i = 0; i < totalChunks; i++) {
    const blob = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await uploadChunk(token, job_id, file.name, i, totalChunks, blob);
    onProgress(Math.round(((i + 1) / totalChunks) * 95));
  }

  return job_id;
}

export async function fetchJobs(token: string) {
  const res = await fetch("/api/jobs", { headers: authHeader(token) });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ active: any[]; history: any[] }>;
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
