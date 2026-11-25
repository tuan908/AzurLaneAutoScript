import { useEffect, useState } from "react";
export function useNow(intervalMs: number | null = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (intervalMs === null) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
