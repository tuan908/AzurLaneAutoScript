export function Brand() {
  return (
    <div className="flex items-center gap-2.5 font-bold tracking-[-.01em] min-[861px]:min-w-60 [&_small]:block [&_small]:text-[11px] [&_small]:font-medium [&_small]:tracking-normal [&_small]:text-subtle">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-linear-to-br from-accent to-violet-500 text-[13px] font-extrabold text-white" aria-hidden="true">AL</span>
      <span>
        ALAS Control Center
        <small>Local automation server</small>
      </span>
    </div>
  );
}
