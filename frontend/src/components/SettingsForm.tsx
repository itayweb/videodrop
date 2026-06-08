import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { fetchFullConfig, saveConfig, FullConfig } from "@/lib/api";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

interface Props {
  token: string;
  onPasswordChanged: () => void;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-foreground uppercase tracking-wide mb-3 mt-6 first:mt-0">
      {children}
    </h3>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 mb-3">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function SettingsForm({ token, onPasswordChanged }: Props) {
  const [cfg, setCfg] = useState<FullConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [originalPassword, setOriginalPassword] = useState("");

  useEffect(() => {
    fetchFullConfig(token)
      .then((data) => {
        setCfg(data);
        setOriginalPassword(data.password);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!cfg) return <p className="text-sm text-destructive">{error || "Failed to load config"}</p>;

  function update(patch: Partial<FullConfig>) {
    setCfg((prev) => prev ? { ...prev, ...patch } : prev);
  }

  function updateTelegram(patch: Partial<NonNullable<FullConfig["telegram"]>>) {
    setCfg((prev) => {
      if (!prev) return prev;
      const tg = prev.telegram ?? { api_id: null, api_hash: null, session_file: "telegram.session", bot_token: null, chat_id: null };
      return { ...prev, telegram: { ...tg, ...patch } };
    });
  }

  function updateArr(key: "sonarr" | "radarr", patch: Partial<{ url: string; api_key: string }>) {
    setCfg((prev) => {
      if (!prev) return prev;
      const cur = prev[key] ?? { url: "", api_key: "" };
      return { ...prev, [key]: { ...cur, ...patch } };
    });
  }

  function addMount() {
    update({ mounts: [...cfg.mounts, { name: "", path: "" }] });
  }

  function removeMount(i: number) {
    update({ mounts: cfg.mounts.filter((_, idx) => idx !== i) });
  }

  function updateMount(i: number, patch: Partial<{ name: string; path: string }>) {
    const mounts = cfg.mounts.map((m, idx) => idx === i ? { ...m, ...patch } : m);
    update({ mounts });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      await saveConfig(token, cfg);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      if (cfg.password !== originalPassword) {
        onPasswordChanged();
      }
    } catch (err: any) {
      setError(err.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const tg = cfg.telegram;
  const passwordChanged = cfg.password !== originalPassword;

  return (
    <form onSubmit={handleSave} className="space-y-1">

      {/* General */}
      <SectionTitle>General</SectionTitle>

      <Field label="Password">
        <Input
          type="text"
          value={cfg.password}
          onChange={(e) => update({ password: e.target.value })}
        />
        {passwordChanged && (
          <p className="text-xs text-yellow-400">⚠ Changing password will log you out</p>
        )}
      </Field>

      <Field label="Max concurrent jobs">
        <Input
          type="number"
          min={1}
          max={10}
          value={cfg.max_concurrent_jobs}
          onChange={(e) => update({ max_concurrent_jobs: parseInt(e.target.value) || 1 })}
        />
      </Field>

      {/* Mounts */}
      <SectionTitle>Mounts</SectionTitle>

      {cfg.mounts.map((m, i) => (
        <div key={i} className="flex gap-2 mb-2">
          <Input
            placeholder="Name"
            value={m.name}
            onChange={(e) => updateMount(i, { name: e.target.value })}
            className="w-1/3"
          />
          <Input
            placeholder="/path/to/mount"
            value={m.path}
            onChange={(e) => updateMount(i, { path: e.target.value })}
            className="flex-1"
          />
          <Button type="button" variant="ghost" size="icon" onClick={() => removeMount(i)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addMount}>
        <Plus className="h-4 w-4 mr-1" /> Add mount
      </Button>

      {/* Telegram Download */}
      <SectionTitle>Telegram Download (Telethon)</SectionTitle>

      <Field label="API ID">
        <Input
          type="number"
          placeholder="12345678"
          value={tg?.api_id ?? ""}
          onChange={(e) => updateTelegram({ api_id: parseInt(e.target.value) || null })}
        />
      </Field>
      <Field label="API Hash">
        <Input
          placeholder="abc123..."
          value={tg?.api_hash ?? ""}
          onChange={(e) => updateTelegram({ api_hash: e.target.value || null })}
        />
      </Field>
      <Field label="Session file">
        <Input
          placeholder="telegram.session"
          value={tg?.session_file ?? "telegram.session"}
          onChange={(e) => updateTelegram({ session_file: e.target.value })}
        />
      </Field>

      {/* Telegram Bot Notifications */}
      <SectionTitle>Telegram Bot Notifications</SectionTitle>

      <Field label="Bot token">
        <Input
          placeholder="123456:ABC-DEF..."
          value={tg?.bot_token ?? ""}
          onChange={(e) => updateTelegram({ bot_token: e.target.value || null })}
        />
      </Field>
      <Field label="Chat ID">
        <Input
          placeholder="Your chat ID (e.g. 123456789)"
          value={tg?.chat_id ?? ""}
          onChange={(e) => updateTelegram({ chat_id: e.target.value || null })}
        />
      </Field>

      {/* Sonarr */}
      <SectionTitle>Sonarr</SectionTitle>

      <Field label="URL">
        <Input
          placeholder="http://localhost:8989"
          value={cfg.sonarr?.url ?? ""}
          onChange={(e) => updateArr("sonarr", { url: e.target.value })}
        />
      </Field>
      <Field label="API Key">
        <Input
          placeholder="sonarr api key"
          value={cfg.sonarr?.api_key ?? ""}
          onChange={(e) => updateArr("sonarr", { api_key: e.target.value })}
        />
      </Field>

      {/* Radarr */}
      <SectionTitle>Radarr</SectionTitle>

      <Field label="URL">
        <Input
          placeholder="http://localhost:7878"
          value={cfg.radarr?.url ?? ""}
          onChange={(e) => updateArr("radarr", { url: e.target.value })}
        />
      </Field>
      <Field label="API Key">
        <Input
          placeholder="radarr api key"
          value={cfg.radarr?.api_key ?? ""}
          onChange={(e) => updateArr("radarr", { api_key: e.target.value })}
        />
      </Field>

      <div className="pt-4 flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {success && <span className="text-sm text-green-500">Saved ✓</span>}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </form>
  );
}
