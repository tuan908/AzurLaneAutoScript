import { useEffect, useRef } from "react";

import { Button } from "@/shared/ui/button";

import { logTone, severity } from "./log-severity";
import { useLogs } from "./log-store";

export function LogPeek({ id, onOpen }: { id: string; onOpen: () => void }) {
  const lines = useLogs(id);
  const last = lines.slice(-14);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (last.length && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [last]);
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-alas border border-edge bg-terminal shadow-alas">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#38383a] bg-[#242426] px-2.5 py-2 text-terminal-dim [&_input:not([type=checkbox])]:w-55 [&_input:not([type=checkbox])]:min-h-7 [&_input:not([type=checkbox])]:border-[#3a3a3c] [&_input:not([type=checkbox])]:bg-[#1c1c1e] [&_input:not([type=checkbox])]:text-[12.5px] [&_input:not([type=checkbox])]:text-terminal-text [&_label]:inline-flex [&_label]:items-center [&_label]:gap-1.5 [&_label]:text-xs max-[600px]:[&_input:not([type=checkbox])]:w-full">
        <span>Live log</span>
        <Button
          size="small"
          className="ml-auto border-transparent! bg-white/12! text-terminal-text! hover:bg-white/18!"
          onClick={onOpen}
        >
          Open logs
        </Button>
      </div>
      <div
        className="relative min-h-0 overflow-auto py-2 font-code text-xs leading-[1.5] text-terminal-text focus-visible:outline-offset-[-2px] h-55"
        ref={ref}
        role="region"
        aria-label="Latest log lines"
        tabIndex={0}
      >
        {last.length === 0 ? (
          <div className="px-3.5 py-6 text-terminal-dim">No log lines yet.</div>
        ) : (
          last.map((line) => (
            <div
              key={line.seq}
              className={`w-full px-3.5 whitespace-pre-wrap wrap-break-word hover:bg-terminal-sel ${logTone(severity(line.text))}`}
            >
              {line.text}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
