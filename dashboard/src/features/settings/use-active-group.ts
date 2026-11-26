import { useEffect, useState } from "react";

// The group whose heading sits nearest below the sticky workspace header.
export function useActiveGroup(ids: string[]) {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join("|");
  useEffect(() => {
    const headings = key
      .split("|")
      .filter(Boolean)
      .map((id) => document.getElementById(`group-${id}`))
      .filter((el): el is HTMLElement => el !== null);
    if (!headings.length) return undefined;
    const visible = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        const first = headings.find((h) => visible.has(h));
        if (first) setActive(first.id.slice("group-".length));
        else {
          const above = headings.filter((h) => h.getBoundingClientRect().top < 160);
          setActive((above.at(-1) ?? headings[0])?.id.slice("group-".length) ?? null);
        }
      },
      { rootMargin: "-150px 0px -45% 0px" },
    );
    for (const h of headings) observer.observe(h);
    return () => observer.disconnect();
  }, [key]);
  return active;
}
