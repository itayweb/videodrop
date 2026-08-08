import { useEffect, useRef, useState } from "react";
import { CheckCircle } from "lucide-react";
import { searchSonarr } from "@/lib/api";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";

export interface SonarrResult {
  tvdbId: number;
  title: string;
  year: number;
  overview: string;
  inSonarr: boolean;
  /** Series folder, only set once the series is in Sonarr — tells us which drive it lives on */
  path: string | null;
}

interface Props {
  token: string;
  value: SonarrResult | null;
  onChange: (series: SonarrResult | null) => void;
  disabled?: boolean;
}

export function SeriesSearch({ token, value, onChange, disabled }: Props) {
  const [query, setQuery] = useState(value?.title ?? "");
  const [results, setResults] = useState<SonarrResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (query.length < 2 || value) {
      setResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await searchSonarr(token, query);
        setResults(found);
        setShowDropdown(true);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [query, value, token]);

  function select(s: SonarrResult) {
    onChange(s);
    setQuery(s.title);
    setShowDropdown(false);
  }

  return (
    <div className="relative">
      <Input
        placeholder="Search TV series…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(null);
        }}
        disabled={disabled}
        autoComplete="off"
      />
      {searching && (
        <p className="text-xs text-muted-foreground mt-1">Searching Sonarr…</p>
      )}
      {showDropdown && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg max-h-64 overflow-y-auto">
          {results.map((s) => (
            <button
              key={s.tvdbId}
              type="button"
              onClick={() => select(s)}
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
      {value && (
        <p className="text-xs text-muted-foreground mt-1">
          Selected: <span className="text-foreground font-medium">{value.title} ({value.year})</span>
          {!value.inSonarr && <span className="text-yellow-400 ml-2">— will be added to Sonarr</span>}
        </p>
      )}
    </div>
  );
}
