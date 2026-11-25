import { Button } from "@/shared/ui/button";

import type { useConfigEditor } from "./use-config-editor";

export function SaveBar({
  editor,
  saveBlocked,
}: {
  editor: ReturnType<typeof useConfigEditor>;
  saveBlocked: boolean;
}) {
  const { edits, errors, notice, conflict } = editor;
  const editCount = Object.keys(edits).length;
  if (!editCount && notice === null && !conflict && editor.error === null) return null;
  return (
    <div
      className="fixed inset-x-3 bottom-5 z-20 mx-auto flex max-w-240 flex-wrap items-center gap-3 rounded-xl border border-edge-strong bg-panel py-2.5 pr-3 pl-4 shadow-alas-lg min-[861px]:right-6 min-[861px]:left-74"
      role="region"
      aria-label="Unsaved changes"
    >
      <span className="text-[13px]">
        {conflict ? (
          <span className="text-bad">The config changed elsewhere (GUI or a running task).</span>
        ) : editor.error !== null && !Object.keys(errors).length ? (
          <span className="text-bad">{editor.error?.message}</span>
        ) : Object.keys(errors).length ? (
          <span className="text-bad">Fix the highlighted values; nothing was saved.</span>
        ) : notice && !editCount ? (
          <span className="text-ok">{notice}</span>
        ) : (
          <span>
            {editCount} unsaved change{editCount === 1 ? "" : "s"}
          </span>
        )}
      </span>
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
