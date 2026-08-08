import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import type { Mount } from "@/lib/api";
import { formatBytes } from "@/lib/utils";

interface Props {
  mounts: Mount[];
  value: string;
  onChange: (name: string) => void;
}

export function MountPicker({ mounts, value, onChange }: Props) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select destination mount…" />
      </SelectTrigger>
      <SelectContent>
        {mounts.map((m) => (
          <SelectItem key={m.name} value={m.name}>
            <span className="font-medium">{m.name}</span>
            <span className="ml-2 text-muted-foreground text-xs">{m.path}</span>
            {m.free_bytes != null && (
              <span className="ml-2 text-muted-foreground text-xs">
                · {formatBytes(m.free_bytes)} free
              </span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
