import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ApiError, api, type ConfigField, type ConfigValue } from "./api";
import { changeDraft, draftValue, type Draft } from "./config-draft";
import { queries } from "./queries";

export function useConfigEditor(id: string) {
  const qc = useQueryClient();
  const doc = useQuery(queries.config(id));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const lock = useRef(false);
  const save = useMutation({
    mutationFn: (submitted: Draft) => api.updateConfig(id, submitted.baseline.revision, submitted.edits),
    onSuccess: async (result) => {
      // Do not let a new draft begin against the previous revision.
      await Promise.all([
        qc.invalidateQueries({ queryKey: queries.config(id).queryKey }),
        qc.invalidateQueries({ queryKey: queries.tasks(id).queryKey }),
      ]);
      setDraft(null);
      setErrors({});
      setConflict(false);
      setNotice(`Saved ${Object.keys(result.applied).length} setting(s)`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      if (error instanceof ApiError && error.status === 400 && error.body["fields"] && typeof error.body["fields"] === "object") {
        setErrors(Object.fromEntries(Object.entries(error.body["fields"]).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
      }
    },
    onSettled: () => { lock.current = false; },
  });
  const stale = !!draft && !!doc.data && draft.baseline.revision !== doc.data.revision;
  const busy = save.isPending || refreshing;
  const blocked = busy || doc.isError || conflict || stale;
  return {
    doc, edits: draft?.edits ?? {}, errors, notice, conflict: conflict || stale, busy, blocked,
    error: save.error,
    valueOf: (field: ConfigField) => draftValue(draft, doc.data, field.path),
    change(field: ConfigField, value: ConfigValue) {
      if (lock.current || blocked || !doc.data || field.readOnly) return;
      const document = doc.data;
      setDraft(previous => changeDraft(previous, document, field, value));
      setNotice(null);
      setErrors(previous => { const next = { ...previous }; delete next[field.path]; return next; });
      save.reset();
    },
    submit() {
      if (lock.current || blocked || !draft) return;
      lock.current = true;
      setNotice(null);
      save.mutate(draft);
    },
    discard() {
      if (lock.current || busy) return;
      setDraft(null);
      setErrors({});
      setConflict(false);
      setNotice(null);
      save.reset();
    },
    async reload() {
      if (lock.current || busy) return;
      lock.current = true;
      setRefreshing(true);
      try {
        const result = await doc.refetch();
        if (!result.isSuccess) return;
        setDraft(null); setErrors({}); setConflict(false); setNotice(null); save.reset();
      } finally { lock.current = false; setRefreshing(false); }
    },
  };
}
