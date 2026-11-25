import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { splitHelp } from "./help";

export function SettingHelp({ text, about, className = "" }: { text: string; about: string; className?: string }) {
  const [summary, more] = splitHelp(text);
  if (!summary) return null;
  if (!more) return <p className={`whitespace-pre-line text-xs text-subtle ${className}`}>{summary}</p>;
  return (
    <Collapsible className={`text-xs text-subtle ${className}`}>
      <p className="whitespace-pre-line">
        {summary}{" "}
        <CollapsibleTrigger className="inline! h-auto! min-h-0! rounded-sm! border-0! bg-transparent! p-0! align-baseline text-xs! font-semibold text-accent! hover:underline [&[data-open]_.more]:hidden [&:not([data-open])_.less]:hidden">
          <span className="more">More</span><span className="less">Less</span><span className="sr-only"> about {about}</span>
        </CollapsibleTrigger>
      </p>
      <CollapsiblePanel className="mt-1 whitespace-pre-line">{more}</CollapsiblePanel>
    </Collapsible>
  );
}
