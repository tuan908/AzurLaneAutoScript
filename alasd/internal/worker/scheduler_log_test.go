package worker

import (
	"encoding/json"
	"os"
	"testing"
)

// Same fixture as tests/control/test_scheduler_log.py (which checks alas.py writes these
// markers) and the dashboard's completions test.
func TestSchedulerMarkers(t *testing.T) {
	data, err := os.ReadFile("../../../tests/control/fixtures/scheduler_log.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Lines []struct {
			Text  string `json:"text"`
			Start string `json:"start"`
			End   string `json:"end"`
		} `json:"lines"`
		Counters struct {
			Successes int `json:"successes"`
			Failures  int `json:"failures"`
		} `json:"counters"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	m := NewManager("alas", Config{Root: t.TempDir()})
	r := &run{}
	for _, line := range fixture.Lines {
		m.trackActivity(r, line.Text)
		switch {
		case line.Start != "" && m.currentTask != line.Start:
			t.Errorf("%q: current task %q, want %q", line.Text, m.currentTask, line.Start)
		case line.End != "" && m.currentTask != "":
			t.Errorf("%q: current task %q after the end marker", line.Text, m.currentTask)
		}
	}
	if m.taskSuccesses != fixture.Counters.Successes || m.taskFailures != fixture.Counters.Failures {
		t.Errorf("counters %d/%d, want %d/%d", m.taskSuccesses, m.taskFailures,
			fixture.Counters.Successes, fixture.Counters.Failures)
	}
}
