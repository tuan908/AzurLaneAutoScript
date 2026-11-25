const paths = {
  play: "M5 3.5v9l7.5-4.5z",
  stop: "M4 4h8v8H4z",
  restart: "M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3",
  plus: "M8 3v10M3 8h10",
  download: "M8 2.5v8m0 0 3-3m-3 3-3-3M3 13.5h10",
};

export function Icon({ name }: { name: keyof typeof paths }) {
  const filled = name === "play" || name === "stop";
  return (
    <svg
      className="size-4 shrink-0"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
