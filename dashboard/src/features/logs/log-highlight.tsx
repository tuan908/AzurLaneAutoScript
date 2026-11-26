import type { ReactNode } from "react";

// Apple dark-mode system colors; the console background is dark in both themes.
const LEVEL: Record<string, string> = {
  DEBUG: "text-terminal-dim",
  INFO: "text-[#5ac8fa]",
  WARNING: "text-[#ffd60a] font-semibold",
  ERROR: "text-[#ff6961] font-semibold",
  CRITICAL: "text-[#ff6961] font-bold",
};

const PREFIX =
  /^(\s*)(?:(\d{4}-\d\d-\d\d )?(\d\d:\d\d:\d\d(?:\.\d+)?)\s*\|\s*(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s*\|\s?|(DEBUG|INFO|WARNING|ERROR|CRITICAL)(\s+)(\d\d:\d\d:\d\d(?:\.\d+)?)\s*\|\s?)/;

const TOKENS =
  /(<<<.*?>>>)|(`[^`\n]*`)|('[^'\n]*'|"[^"\n]*")|(\[[^\]\n]{1,48}\])|(@ ?[A-Z][A-Z0-9_]{2,})|\b(True|False|None)\b|(-?\b\d+(?:\.\d+)?%?)/g;

const TOKEN_CLASS = [
  "text-[#da8fff] font-semibold", // <<< SECTION >>>
  "text-[#30d158]", // `Task`
  "text-[#ffb07a]", // 'quoted'
  "text-[#66d4cf]", // [TAG]
  "text-[#ff9f0a]", // @ BUTTON_NAME
  "text-[#ff8fb1]", // True / False / None
  "text-[#c8b3ff]", // numbers
];

const EXCEPTION = /^[A-Za-z_.]*(?:Error|Exception|Takeover|Interrupt)\b:?/;

const RULE = /^[\s─═━-]*[─═━]{4,}/;

function message(text: string): ReactNode[] {
  if (RULE.test(text))
    return [
      <span key="rule" className="font-semibold text-[#da8fff]">
        {text}
      </span>,
    ];
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKENS)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const group = match.slice(1).findIndex((g) => g !== undefined);
    parts.push(
      <span key={at} className={TOKEN_CLASS[group]}>
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function LogText({ text }: { text: string }) {
  const prefix = PREFIX.exec(text);
  if (!prefix && EXCEPTION.test(text))
    return <span className="font-bold text-[#ff6961]">{text}</span>;
  if (!prefix) return <>{message(text)}</>;
  const [whole, indent = "", date = "", time1, level1, level2, gap = " ", time2] = prefix;
  const level = (level1 ?? level2 ?? "") as string;
  const time = time1 ?? time2 ?? "";
  return (
    <>
      {indent}
      {level2 ? (
        <>
          <span className={LEVEL[level]}>{level}</span>
          {gap}
          <span className="text-terminal-dim">{time}</span>
        </>
      ) : (
        <>
          <span className="text-terminal-dim">
            {date}
            {time}
          </span>{" "}
          <span className={LEVEL[level]}>{level.padEnd(8)}</span>
        </>
      )}
      <span className="text-[#48484a]"> │ </span>
      {message(text.slice(whole.length))}
    </>
  );
}
