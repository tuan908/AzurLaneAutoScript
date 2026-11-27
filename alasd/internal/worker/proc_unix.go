//go:build !windows

package worker

import (
	"os/exec"
	"syscall"
)

// Workers get their own process group, so a Ctrl+C on the server terminal reaches the
// server only; the server then stops its workers gracefully.
func Detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
