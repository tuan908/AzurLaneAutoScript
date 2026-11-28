//go:build windows

package proc

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// A new process group keeps the console Ctrl+C away from the workers, the server stops them
// gracefully. CREATE_NO_WINDOW: no console window for the Python process.
func Detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW,
	}
}
