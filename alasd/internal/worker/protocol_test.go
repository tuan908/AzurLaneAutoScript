package worker

import (
	"os"
	"regexp"
	"strconv"
	"testing"
)

// pythonConstants reads `NAME = value` lines (int or string) of a Python file of the ALAS root.
func pythonConstants(t *testing.T, file string) map[string]string {
	t.Helper()
	data, err := os.ReadFile("../../../" + file)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	re := regexp.MustCompile(`(?m)^([A-Z][A-Z0-9_]*) = (\d+|"[^"]*"|'[^']*')\s*(?:#.*)?$`)
	for _, m := range re.FindAllStringSubmatch(string(data), -1) {
		value := m[2]
		if value[0] == '"' || value[0] == '\'' {
			value = value[1 : len(value)-1]
		}
		out[m[1]] = value
	}
	return out
}

// The Python worker is the source of the protocol; these are the copies alasd uses.
func TestProtocolMatchesPythonWorker(t *testing.T) {
	exception := pythonConstants(t, "module/exception.py")
	worker := pythonConstants(t, "module/control/worker.py")
	cases := []struct {
		python, value, goValue string
	}{
		{"HUMAN_TAKEOVER_EXIT_CODE", exception["HUMAN_TAKEOVER_EXIT_CODE"], strconv.Itoa(HumanTakeoverExitCode)},
		{"RETRY_LATER_EXIT_CODE", exception["RETRY_LATER_EXIT_CODE"], strconv.Itoa(RetryLaterExitCode)},
		{"ALREADY_RUNNING_EXIT_CODE", worker["ALREADY_RUNNING_EXIT_CODE"], strconv.Itoa(AlreadyRunningExitCode)},
		{"WORKER_LOCK_DIR", worker["WORKER_LOCK_DIR"], "./" + LockDir},
		{"LOG_KEY", worker["LOG_KEY"], LogKey},
		{"STOP_COMMAND", worker["STOP_COMMAND"], StopCommand},
	}
	for _, c := range cases {
		if c.value == "" {
			t.Errorf("%s not found in the Python source", c.python)
		} else if c.value != c.goValue {
			t.Errorf("%s: Python %q, Go %q", c.python, c.value, c.goValue)
		}
	}
}
