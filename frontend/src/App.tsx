import { useEffect, useState, useCallback } from "react";
import { Film, RefreshCw, LogOut } from "lucide-react";
import * as Tabs from "@radix-ui/react-tabs";
import { fetchConfig, fetchJobs } from "./lib/api";
import { UrlForm } from "./components/UrlForm";
import { UploadZone } from "./components/UploadZone";
import { JobProgress } from "./components/JobProgress";
import { HistoryTable } from "./components/HistoryTable";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";

interface Mount {
  name: string;
  path: string;
}

interface ActiveJob {
  jobId: string;
  source: string;
  type: "url" | "upload";
  mountName: string;
}

interface HistoryJob {
  id: string;
  type: string;
  source: string;
  dest_mount: string;
  dest_path: string | null;
  status: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await fetchConfig(pw);
      onLogin(pw);
    } catch {
      setError("Wrong password");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="flex items-center gap-3 justify-center">
          <Film className="h-8 w-8 text-primary" />
          <h1 className="text-2xl font-bold">VideoDrop</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Input
            type="password"
            placeholder="Password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoFocus
          />
          <Button type="submit" className="w-full">Sign in</Button>
          {error && <p className="text-xs text-destructive text-center">{error}</p>}
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("vd_token") ?? "");
  const [authed, setAuthed] = useState(false);
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const [history, setHistory] = useState<HistoryJob[]>([]);
  const [tab, setTab] = useState("new");
  const [refreshing, setRefreshing] = useState(false);

  async function login(pw: string) {
    const cfg = await fetchConfig(pw);
    sessionStorage.setItem("vd_token", pw);
    setToken(pw);
    setMounts(cfg.mounts);
    setAuthed(true);
    loadHistory(pw);
  }

  async function loadHistory(t = token) {
    setRefreshing(true);
    try {
      const data = await fetchJobs(t);
      setHistory(data.history);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (token) login(token).catch(() => setAuthed(false));
  }, []);

  function handleJobCreated(jobId: string, source: string, mountName: string, type: "url" | "upload") {
    setActiveJobs((prev) => [...prev, { jobId, source, type, mountName }]);
  }

  function handleJobDone(jobId: string) {
    setActiveJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    loadHistory();
  }

  function logout() {
    sessionStorage.removeItem("vd_token");
    setToken("");
    setAuthed(false);
  }

  if (!authed) return <LoginScreen onLogin={login} />;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Film className="h-6 w-6" />
          <span className="font-bold text-lg">VideoDrop</span>
        </div>
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Active jobs */}
        {activeJobs.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">Active Jobs</h2>
            {activeJobs.map((j) => (
              <JobProgress
                key={j.jobId}
                token={token}
                jobId={j.jobId}
                source={j.source}
                type={j.type}
                mountName={j.mountName}
                onDone={() => handleJobDone(j.jobId)}
              />
            ))}
          </section>
        )}

        {/* New job tabs */}
        <Tabs.Root value={tab} onValueChange={setTab}>
          <Tabs.List className="flex border-b border-border mb-6">
            {["new", "history"].map((t) => (
              <Tabs.Trigger
                key={t}
                value={t}
                className={cn(
                  "px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2",
                  tab === t
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "new" ? "New Job" : "History"}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content value="new" className="space-y-8">
            <section>
              <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">Telegram / URL</h2>
              <UrlForm
                token={token}
                mounts={mounts}
                onJobCreated={(id, src, mount) => handleJobCreated(id, src, mount, "url")}
              />
            </section>
            <div className="border-t border-border" />
            <section>
              <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">Upload File</h2>
              <UploadZone
                token={token}
                mounts={mounts}
                onJobCreated={(id, src, mount) => handleJobCreated(id, src, mount, "upload")}
              />
            </section>
          </Tabs.Content>

          <Tabs.Content value="history">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Job History</h2>
              <Button variant="ghost" size="sm" onClick={() => loadHistory()} disabled={refreshing}>
                <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
                Refresh
              </Button>
            </div>
            <HistoryTable jobs={history} />
          </Tabs.Content>
        </Tabs.Root>
      </main>
    </div>
  );
}
