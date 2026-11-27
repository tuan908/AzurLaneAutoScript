package worker

import (
	"os"
	"path/filepath"
)

// LockDir holds one lock file per instance. The Python worker holds it (filelock.FileLock) while it
// runs, so a worker started by another server or launcher is seen as "unmanaged".
const LockDir = "config/tmp/workers"

// LockPath of an instance, relative to the ALAS root.
func LockPath(root, id string) string {
	return filepath.Join(root, LockDir, id+".lock")
}

// HeldElsewhere tells if another process holds the worker lock of an instance.
func HeldElsewhere(path string) bool {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		// Windows refuses to open a file that is being deleted by its owner; treat as free
		return false
	}
	defer f.Close()
	locked, err := tryLock(f)
	if err != nil {
		return false
	}
	if !locked {
		return true
	}
	unlock(f)
	return false
}
