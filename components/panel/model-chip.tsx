import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TONES: Record<string, string> = {
  opus: "text-violet border-violet/35",
  sonnet: "text-info border-info/35",
  haiku: "text-success border-success/35",
  fable: "text-warning border-warning/35",
};

export function ModelChip({ model }: { model: string | null }) {
  if (!model) return null;
  const family = Object.keys(TONES).find((name) => model.includes(name));
  return (
    <Badge
      variant="outline"
      className={cn("rounded-md font-normal", family && TONES[family])}
    >
      {model.replace(/^claude-/, "")}
    </Badge>
  );
}
