import { getRouteApi } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Input } from "@ui-sdk/react/input";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Icon } from "@/shared/ui/icon";

import { logTone, severity } from "./log-severity";
import { useLogs } from "./log-store";
import { LOG_LEVELS, type LogsSearch } from "./search";

type LogLevel = LogsSearch["level"];
const LEVEL_LABELS: Record<LogLevel, string> = { all: "All", warn: "Warnings+", error: "Errors" };
const logLevels = LOG_LEVELS.map((value) => ({ value, label: LEVEL_LABELS[value] }));

const route = getRouteApi("/$instanceId/logs");

export function Logs() {
  "use no memo";
  const { instanceId } = route.useParams();
  const { filter, level } = route.useSearch();
  const navigate = route.useNavigate();
  const lines = useLogs(instanceId);
  const updateFilter = (next: string) => {
    void navigate({
      search: (previous) => ({ ...previous, filter: next }),
      replace: true,
    });
  };
  const updateLevel = (next: LogLevel | null) => {
    if (next === null) return;
    void navigate({
      search: (previous) => ({ ...previous, level: next }),
      replace: true,
    });
  };
  const [follow, setFollow] = useState(true);
  const scrollRegion = useRef<HTMLDivElement>(null);
  const filteredLines = useMemo(() => {
    const searchText = filter.trim().toLowerCase();
    return lines.filter((line) => {
      if (searchText && !line.text.toLowerCase().includes(searchText)) return false;
      if (level === "all") return true;

      const lineLevel = severity(line.text);
      return level === "error" ? lineLevel === "error" : lineLevel !== "";
    });
  }, [lines, filter, level]);
  // oxlint-disable-next-line react/incompatible-library -- This component opts out of React Compiler and keeps the virtualizer local.
  const virtualLog = useVirtualizer({
    count: filteredLines.length,
    getScrollElement: () => scrollRegion.current,
    getItemKey: (index) => filteredLines[index]?.seq ?? `missing-${index}`,
    estimateSize: () => 18,
    overscan: 12,
    useFlushSync: false,
  });

  useEffect(() => {
    if (follow && filteredLines.length > 0) {
      virtualLog.scrollToIndex(filteredLines.length - 1, { align: "end" });
    }
  }, [filteredLines, follow, virtualLog]);

  const download = () => {
    const content = filteredLines.map((line) => line.text).join("\n");
    const downloadUrl = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `${instanceId}-log.txt`;
    link.click();
    URL.revokeObjectURL(downloadUrl);
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-alas border border-edge bg-terminal shadow-alas">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1d2330] bg-[#121620] px-2.5 py-2 text-terminal-dim [&_input:not([type=checkbox])]:w-55 [&_input:not([type=checkbox])]:min-h-7 [&_input:not([type=checkbox])]:border-[#262d3b] [&_input:not([type=checkbox])]:bg-[#0b0e14] [&_input:not([type=checkbox])]:text-[12.5px] [&_input:not([type=checkbox])]:text-terminal-text [&_label]:inline-flex [&_label]:items-center [&_label]:gap-1.5 [&_label]:text-xs max-[600px]:[&_input:not([type=checkbox])]:w-full">
        <Input
          aria-label="Filter logs"
          placeholder="Filter…"
          value={filter}
          onValueChange={updateFilter}
        />
        <SegmentedControl
          className="inline-flex rounded-full border border-[#262d3b] p-0.5 [&_button]:h-5.5 [&_button]:rounded-full [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-2.5 [&_button]:text-xs [&_button]:text-terminal-dim [&_button[data-checked]]:bg-terminal-sel [&_button[data-checked]]:text-terminal-text"
          aria-label="Log level"
          value={level}
          onValueChange={updateLevel}
        >
          <SegmentedControlIndicator />
          {logLevels.map(({ value, label }) => (
            <SegmentedControlItem key={value} value={value}>
              {label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <label htmlFor="follow-logs">
          <Checkbox
            id="follow-logs"
            aria-label="Follow logs"
            checked={follow}
            onCheckedChange={(next) => setFollow(next === true)}
          >
            <CheckboxIndicator />
          </Checkbox>
          Follow
        </label>
        <Button size="small" onClick={download}>
          <Icon name="download" />
          Export
        </Button>
        <span className="ml-auto text-xs tabular-nums">
          {filteredLines.length.toLocaleString()} / {lines.length.toLocaleString()} lines
        </span>
      </div>
      <div
        className="relative overflow-auto py-2 font-code text-xs leading-relaxed text-terminal-text focus-visible:-outline-offset-2 h-[70vh] min-h-90 min-[861px]:h-[calc(100vh-230px)]"
        ref={scrollRegion}
        role="region"
        aria-label="Recent log lines"
        tabIndex={0}
      >
        {filteredLines.length === 0 ? (
          <div className="px-3.5 py-6 text-terminal-dim">
            {lines.length ? "No line matches the filter." : "No log lines yet."}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualLog.getTotalSize() }}>
            {virtualLog.getVirtualItems().map((item) => {
              const line = filteredLines[item.index];
              if (!line) return null;
              const tone = logTone(severity(line.text));
              return (
                <div
                  key={item.key}
                  ref={virtualLog.measureElement}
                  data-index={item.index}
                  className={`absolute top-0 left-0 w-full px-3.5 whitespace-pre-wrap wrap-break-word hover:bg-terminal-sel ${tone}`}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {line.text}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
