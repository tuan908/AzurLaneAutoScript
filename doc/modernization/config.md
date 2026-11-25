# Configuration editor

ALAS metadata drives the settings menu, labels, field types, options and validation.
Internal storage stays hidden. Lock and state fields that appear in the menu are read-only.
The editor currently targets base ALAS profiles.

The revision is derived from the file bytes. PATCH accepts `If-Match` or the existing
JSON `revision` field. The editor pins the revision when the first field changes, so a
refetch during editing cannot silently accept an older user's changes. The API validates
every edit before writing, applies the updater's derived changes, and preserves unknown
keys. The dashboard explains conflicts and lets the user reload.

The worker, legacy UI and API serialize writes using the shared per-config lock and
atomic replacement. The worker applies only its modified fields to the latest stored
document, preserving edits to other fields.
