import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface Mount {
  name: string;
  path: string;
}

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
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
