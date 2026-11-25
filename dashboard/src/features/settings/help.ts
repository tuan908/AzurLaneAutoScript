const PREVIEW_CHARS = 140;

export function splitHelp(help: string): [string, string] {
  const [first = "", ...rest] = help.trim().split("\n");
  if (rest.length) return [first, rest.join("\n")];
  if (first.length <= PREVIEW_CHARS) return [first, ""];
  const cut = first.lastIndexOf(" ", PREVIEW_CHARS);
  const at = cut > 60 ? cut : PREVIEW_CHARS;
  return [first.slice(0, at), first.slice(at).trimStart()];
}
