import { useEffect, useRef } from "react";

import { Button } from "@/shared/ui/button";

import type { useConfigEditor } from "./use-config-editor";

export function SaveBar({
  editor,
  saveBlocked,
}: {
  editor: ReturnType<typeof useConfigEditor>;
  saveBlocked: boolean;
}) {
  const { edits, errors, conflict } = editor;
  const editCount = Object.keys(edits).length;
  const fieldErrors = Object.entries(errors);
  const errorSummary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editor.error) {
      errorSummary.current?.scrollIntoView({ block: "center" });
      errorSummary.current?.focus({ preventScroll: true });
    }
  }, [editor.error]);

  if (!editCount && !conflict && editor.error === null) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-edge-strong bg-panel py-2.5 pr-3 pl-4 shadow-alas-lg"
      role="region"
      aria-label="Unsaved changes"
    >
      <div
        ref={errorSummary}
        tabIndex={editor.error ? -1 : undefined}
        className="min-w-0 wrap-break-word text-[13px]"
      >
        {conflict ? (
          <span className="text-bad">The config changed elsewhere (GUI or a running task).</span>
        ) : fieldErrors.length > 0 ? (
          <>
            <p className="font-semibold text-bad">Fix these settings before saving.</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {fieldErrors.map(([path, message]) => (
                <li key={path}>
                  {path}: {message}
                </li>
              ))}
            </ul>
          </>
        ) : editor.error !== null ? (
          <span className="text-bad">{editor.error.message}</span>
        ) : (
          <span>
            {editCount} unsaved change{editCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="ml-auto flex flex-wrap gap-2">
        {conflict && (
          <Button disabled={editor.busy} onClick={() => void editor.reload()}>
            Reload, discard my edits
          </Button>
        )}
        <Button disabled={!editCount || editor.busy} onClick={editor.discard}>
          Discard
        </Button>
        <Button
          variant="primary"
          disabled={!editCount || editor.blocked || saveBlocked}
          onClick={editor.submit}
        >
          Save{editCount ? ` (${editCount})` : ""}
        </Button>
      </div>
    </div>
  );
}
