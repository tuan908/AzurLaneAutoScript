import { Input } from "@ui-sdk/react/input";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Button } from "../components/ui";
import { getRouteApi } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LogLine } from "../api";
import { useLogs } from "../logStore";
import { Icon } from "../components/ui";
import { logTone, severity } from "./log-severity";

type Level = "all" | "warn" | "error";

const route = getRouteApi("/$instanceId/logs");

export function Logs() {
  "use no memo";
  const { instanceId: id } = route.useParams();
  const { filter, level } = route.useSearch();
  const navigate = route.useNavigate();
  const lines = useLogs(id);
  const onFilter = (next: string) => void navigate({
    search: (previous) => ({ ...previous, filter: next }), replace: true,
  });
  const onLevel = (next: Level) => void navigate({
    search: (previous) => ({ ...previous, level: next }), replace: true,
  });
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return lines.filter((l: LogLine) => {
      if (f && !l.text.toLowerCase().includes(f)) return false;
      const s = severity(l.text);
      return level === "all" || (level === "error" ? s === "error" : s !== "");
    });
  }, [lines, filter, level]);
  const virtualLog = useVirtualizer({
    count: shown.length,
    getScrollElement: () => ref.current,
    getItemKey: (index) => shown[index]?.seq ?? `missing-${index}`,
    estimateSize: () => 18,
    overscan: 12,
    useFlushSync: false,
  });

  useEffect(() => {
    if (follow && shown.length) virtualLog.scrollToIndex(shown.length - 1, { align: "end" });
  }, [shown, follow, virtualLog]);

  const download = () => {
    const blob = new Blob([shown.map((l) => l.text).join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${id}-log.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-alas border border-edge bg-terminal shadow-alas">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1d2330] bg-[#121620] px-2.5 py-2 text-terminal-dim [&_input:not([type=checkbox])]:w-55 [&_input:not([type=checkbox])]:min-h-7 [&_input:not([type=checkbox])]:border-[#262d3b] [&_input:not([type=checkbox])]:bg-[#0b0e14] [&_input:not([type=checkbox])]:text-[12.5px] [&_input:not([type=checkbox])]:text-terminal-text [&_label]:inline-flex [&_label]:items-center [&_label]:gap-1.5 [&_label]:text-xs max-[600px]:[&_input:not([type=checkbox])]:w-full">
        <Input aria-label="Filter logs" placeholder="Filter…" value={filter} onValueChange={onFilter} />
        <SegmentedControl className="inline-flex rounded-full border border-[#262d3b] p-0.5 [&_button]:h-5.5 [&_button]:rounded-full [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-2.5 [&_button]:text-xs [&_button]:text-terminal-dim [&_button[data-checked]]:bg-terminal-sel [&_button[data-checked]]:text-terminal-text" aria-label="Log level" value={level} onValueChange={(next) => { if (next === "all" || next === "warn" || next === "error") onLevel(next); }}>
          <SegmentedControlIndicator />
          {(["all", "warn", "error"] as Level[]).map((l) => (
            <SegmentedControlItem key={l} value={l}>
              {l === "all" ? "All" : l === "warn" ? "Warnings+" : "Errors"}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <label htmlFor="follow-logs"><Checkbox id="follow-logs" aria-label="Follow logs" checked={follow} onCheckedChange={(next) => setFollow(next === true)}><CheckboxIndicator /></Checkbox> Follow</label>
        <Button size="small" onClick={download}><Icon name="download" />Export</Button>
        <span className="ml-auto text-xs tabular-nums">{shown.length.toLocaleString()} / {lines.length.toLocaleString()} lines</span>
      </div>
      <div className="relative min-h-0 overflow-auto py-2 font-code text-xs leading-relaxed text-terminal-text focus-visible:outline-offset-[-2px] h-[70vh] min-h-90 min-[861px]:h-[calc(100vh-230px)]" ref={ref} role="region" aria-label="Recent log lines" tabIndex={0}>
        {shown.length === 0 ? (
          <div className="px-3.5 py-6 text-terminal-dim">{lines.length ? "No line matches the filter." : "No log lines yet."}</div>
        ) : (
          <div className="relative w-full" style={{ height: virtualLog.getTotalSize() }}>
            {virtualLog.getVirtualItems().map((item) => {
              const line = shown[item.index];
              if (!line) return null;
              const s = severity(line.text);
              return <div key={item.key} ref={virtualLog.measureElement} data-index={item.index}
                className={`absolute top-0 left-0 w-full px-3.5 whitespace-pre-wrap wrap-break-word hover:bg-terminal-sel ${logTone(s)}`} style={{ transform: `translateY(${item.start}px)` }}>{line.text}</div>;
            })}
          </div>
        )}
      </div>
    </section>
  );
}
