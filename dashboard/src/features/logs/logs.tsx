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

import { LogText } from "./log-highlight";
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
  const [pausedAfter, setPausedAfter] = useState(0);
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
    estimateSize: () => 22,
    overscan: 12,
    useFlushSync: false,
  });

  useEffect(() => {
    if (follow && filteredLines.length > 0) {
      virtualLog.scrollToIndex(filteredLines.length - 1, { align: "end" });
    }
  }, [filteredLines, follow, virtualLog]);

  const pause = (paused: boolean) => {
    if (paused === !follow) return;
    setFollow(!paused);
    if (paused) setPausedAfter(filteredLines.at(-1)?.seq ?? 0);
  };
  const newLines = follow ? 0 : filteredLines.filter((line) => line.seq > pausedAfter).length;
  const onScroll = () => {
    const region = scrollRegion.current;
    if (!region) return;
    const fromBottom = region.scrollHeight - region.scrollTop - region.clientHeight;
    pause(fromBottom > 48);
  };
  const jumpToLatest = () => {
    pause(false);
    if (filteredLines.length) virtualLog.scrollToIndex(filteredLines.length - 1, { align: "end" });
  };

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
    <section
      data-fill-height
      className="flex min-h-0 flex-col overflow-hidden min-[861px]:flex-1 rounded-alas border border-edge bg-terminal shadow-alas"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[#38383a] bg-[#242426] px-2.5 py-2 text-terminal-dim [&_input:not([type=checkbox])]:min-h-7 [&_input:not([type=checkbox])]:border-[#3a3a3c] [&_input:not([type=checkbox])]:bg-[#1c1c1e] [&_input:not([type=checkbox])]:text-[12.5px] [&_input:not([type=checkbox])]:text-terminal-text [&_label]:inline-flex [&_label]:items-center [&_label]:gap-1.5 [&_label]:text-xs">
        <Input
          className="min-h-7! min-w-40 flex-1 border-[#3a3a3c]! bg-[#1c1c1e]! text-[12.5px]! text-terminal-text! max-[600px]:basis-full"
          type="search"
          aria-label="Filter logs"
          placeholder="Filter…"
          value={filter}
          onValueChange={updateFilter}
        />
        <SegmentedControl
          className="inline-flex rounded-full border-0 bg-white/10 p-0.5 [&_button]:h-5.5 [&_button]:rounded-full [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-2.5 [&_button]:text-xs [&_button]:text-terminal-dim [&_button[data-checked]]:text-terminal-text [&_[data-slot=segmented-control-indicator]]:rounded-full [&_[data-slot=segmented-control-indicator]]:bg-[#48484a]! [&_[data-slot=segmented-control-indicator]]:shadow-none"
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
            onCheckedChange={(next) => (next === true ? jumpToLatest() : pause(true))}
          >
            <CheckboxIndicator />
          </Checkbox>
          Follow
        </label>
        <Button
          size="small"
          className="border-transparent! bg-white/12! text-terminal-text! hover:bg-white/18!"
          onClick={download}
        >
          <Icon name="download" />
          Export
        </Button>
        <span className="text-xs tabular-nums">
          {filteredLines.length.toLocaleString()} / {lines.length.toLocaleString()} lines
        </span>
      </div>
      <div className="relative flex min-h-0 flex-col min-[861px]:flex-1">
        <div
          onScroll={onScroll}
          className="relative overflow-auto py-2 font-code text-[13.5px] leading-[1.6] text-terminal-text focus-visible:-outline-offset-2 h-[70vh] min-h-90 min-[861px]:h-auto min-[861px]:flex-1"
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
                    <LogText text={line.text} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!follow && (
          <Button
            size="small"
            variant="primary"
            className="absolute right-5 bottom-3 shadow-alas-lg"
            onClick={jumpToLatest}
          >
            <Icon name="download" />
            {newLines > 0 ? `Jump to latest (${newLines.toLocaleString()} new)` : "Jump to latest"}
          </Button>
        )}
      </div>
    </section>
  );
}
