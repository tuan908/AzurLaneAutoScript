package health

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"alasd/internal/instances"
	"alasd/internal/timeutil"
	"alasd/internal/worker"
)

type fakeService struct {
	status    worker.Status
	logs      []worker.LogLine
	recovered []string
	// state after a recovery
	after string
}

func (f *fakeService) Statuses() []instances.Status {
	return []instances.Status{{Status: f.status}}
}

func (f *fakeService) Logs(id string, after int64, limit int) (worker.LogChunk, error) {
	var out []worker.LogLine
	for _, l := range f.logs {
		if l.Seq > after {
			out = append(out, l)
		}
	}
	return worker.LogChunk{Lines: out}, nil
}

func (f *fakeService) Recover(expected worker.Status, reason string) (*worker.Status, error) {
	f.recovered = append(f.recovered, reason)
	f.status.State = f.after
	f.status.Revision++
	now := timeutil.ISO(time.Now())
	f.status.StartedAt = &now
	s := f.status
	return &s, nil
}

func intp(v int) *int { return &v }

type clock struct{ now time.Time }

func (c *clock) Now() time.Time           { return c.now }
func (c *clock) advance(d time.Duration) { c.now = c.now.Add(d) }

func setup(t *testing.T, status worker.Status) (*Monitor, *fakeService, *clock) {
	t.Helper()
	svc := &fakeService{status: status, after: "running"}
	m := NewMonitor(svc, NewPolicyStore(t.TempDir()))
	c := &clock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	m.Clock = c.Now
	return m, svc, c
}

func crashed() worker.Status {
	msg := "Worker exited with code 1"
	return worker.Status{ID: "alas", State: "failed", ExitCode: intp(1), LastError: &msg}
}

func healthOf(m *Monitor) InstanceHealth { return m.InstanceHealth("alas").(InstanceHealth) }

func TestClassification(t *testing.T) {
	m, svc, _ := setup(t, worker.Status{ID: "alas", State: "running"})
	cases := []struct {
		status worker.Status
		want   string
	}{
		{worker.Status{ID: "alas", State: "stopped"}, "stopped"},
		{worker.Status{ID: "alas", State: "starting"}, "ok"},
		{worker.Status{ID: "alas", State: "running"}, "idle"},
		{crashed(), "crashed"},
		{worker.Status{ID: "alas", State: "failed", ExitCode: intp(10)}, "human_takeover"},
		{worker.Status{ID: "alas", State: "failed", ExitCode: intp(11)}, "waiting_retry"},
		{worker.Status{ID: "alas", State: "failed", ExitCode: intp(1), LogDraining: true}, "ok"},
		{worker.Status{ID: "alas", State: "running", Unmanaged: true}, "unmanaged"},
	}
	for _, c := range cases {
		svc.status = c.status
		if got := m.classify(c.status, defaultInstance, time.Now()).state; got != c.want {
			t.Errorf("%+v: %s, want %s", c.status, got, c.want)
		}
	}
}

func TestTakeoverInThisRunOnly(t *testing.T) {
	m, svc, _ := setup(t, crashed())
	svc.logs = []worker.LogLine{{Seq: 3, Text: "CRITICAL Request human takeover"}, {Seq: 9, Text: "Traceback"}}
	s := crashed()
	s.RunLogStartSeq = 5
	if got := m.classify(s, defaultInstance, time.Now()).state; got != "crashed" {
		t.Fatalf("earlier run's takeover counted: %s", got)
	}
	s.RunLogStartSeq = 2
	if got := m.classify(s, defaultInstance, time.Now()).state; got != "human_takeover" {
		t.Fatalf("got %s", got)
	}
}

func TestStall(t *testing.T) {
	m, _, _ := setup(t, worker.Status{})
	task := "Commission"
	old := timeutil.ISO(time.Now().Add(-31 * time.Minute))
	s := worker.Status{ID: "alas", State: "running", CurrentTask: &task, LastActivityAt: &old}
	if got := m.classify(s, defaultInstance, time.Now()); got.state != "stalled" || !strings.Contains(got.detail, "31 min") {
		t.Fatalf("got %+v", got)
	}
	off := defaultInstance
	off.StallMinutes = 0
	if got := m.classify(s, off, time.Now()).state; got != "ok" {
		t.Fatalf("stall detection not disabled: %s", got)
	}
}

func TestCrashRestartWithBackoffAndGiveUp(t *testing.T) {
	m, svc, c := setup(t, crashed())
	m.Tick()
	if h := healthOf(m); h.State != "crashed" || h.Recovery.NextAttemptAt == nil || len(svc.recovered) != 0 {
		t.Fatalf("first tick %+v", h)
	}
	c.advance(31 * time.Second)
	m.Tick()
	if len(svc.recovered) != 1 || m.RestartCount != 1 {
		t.Fatalf("not restarted after the backoff: %v", svc.recovered)
	}
	// It crashes again: the next delay is 120s
	for attempt, delay := range []time.Duration{120 * time.Second, 300 * time.Second} {
		svc.status = crashed()
		m.Tick()
		c.advance(delay - time.Second)
		m.Tick()
		if len(svc.recovered) != attempt+1 {
			t.Fatalf("restarted before %s", delay)
		}
		c.advance(2 * time.Second)
		m.Tick()
		if len(svc.recovered) != attempt+2 {
			t.Fatalf("not restarted after %s", delay)
		}
	}
	svc.status = crashed()
	m.Tick()
	h := healthOf(m)
	if !h.Recovery.GaveUp || h.Recovery.RestartsLastHour != 3 {
		t.Fatalf("did not give up: %+v", h.Recovery)
	}
	c.advance(time.Hour)
	m.Tick()
	if len(svc.recovered) != 3 {
		t.Fatal("restarted after giving up")
	}
	// A manual start resets
	started := timeutil.ISO(c.now.Add(time.Second))
	svc.status = worker.Status{ID: "alas", State: "running", StartedAt: &started}
	c.advance(2 * time.Second)
	m.Tick()
	if healthOf(m).Recovery.GaveUp {
		t.Fatal("manual start did not reset gaveUp")
	}
	if snap := m.Snapshot()["history"].([]Event); snap[0].Action != "gave_up" && snap[len(snap)-1].Action != "scheduled" {
		t.Fatalf("history order %+v", snap)
	}
}

func TestNoRecoveryWhenDisabledOrTakeover(t *testing.T) {
	m, svc, c := setup(t, crashed())
	if _, err := m.Policy.Update(map[string]any{"instances": map[string]any{"alas": map[string]any{"autoRestart": false}}}); err != nil {
		t.Fatal(err)
	}
	m.Tick()
	c.advance(time.Hour)
	m.Tick()
	if len(svc.recovered) != 0 {
		t.Fatal("restarted with autoRestart off")
	}

	m, svc, c = setup(t, worker.Status{ID: "alas", State: "failed", ExitCode: intp(10)})
	m.Tick()
	c.advance(time.Hour)
	m.Tick()
	if len(svc.recovered) != 0 || healthOf(m).State != "human_takeover" {
		t.Fatal("human takeover was restarted")
	}
}

func TestStallRestartOnlyWhenEnabled(t *testing.T) {
	task := "Commission"
	old := timeutil.ISO(time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC))
	m, svc, c := setup(t, worker.Status{ID: "alas", State: "running", CurrentTask: &task, LastActivityAt: &old})
	svc.after = "running"
	m.Tick()
	c.advance(time.Hour)
	m.Tick()
	if len(svc.recovered) != 0 {
		t.Fatal("stall restarted while restartOnStall is off")
	}
	m.Policy.Update(map[string]any{"instances": map[string]any{"alas": map[string]any{"restartOnStall": true}}})
	m.Tick()
	c.advance(31 * time.Second)
	m.Tick()
	if len(svc.recovered) != 1 || svc.recovered[0] != "stalled" {
		t.Fatalf("recovered %v", svc.recovered)
	}
}

func TestLoginFailureWakesHourlyThenGivesUp(t *testing.T) {
	m, svc, c := setup(t, worker.Status{})
	retry := func() {
		stopped := timeutil.ISO(c.now)
		svc.status = worker.Status{ID: "alas", State: "failed", ExitCode: intp(11), StoppedAt: &stopped}
	}
	svc.after = "running"
	retry()
	m.Tick()
	h := healthOf(m)
	if h.State != "waiting_retry" || h.Recovery.PendingReason == nil || *h.Recovery.PendingReason != "waiting_retry" {
		t.Fatalf("health %+v", h)
	}
	c.advance(59 * time.Minute)
	m.Tick()
	if len(svc.recovered) != 0 {
		t.Fatal("woken too early")
	}
	c.advance(2 * time.Minute)
	m.Tick()
	if len(svc.recovered) != 1 {
		t.Fatal("not woken after an hour")
	}
	// It keeps failing to log in for a day
	for i := 0; i < 30; i++ {
		retry()
		m.Tick()
		c.advance(61 * time.Minute)
		m.Tick()
	}
	if !healthOf(m).Recovery.GaveUp {
		t.Fatal("did not give up after a day")
	}
	if n := len(svc.recovered); n < 23 || n > 25 {
		t.Fatalf("woken %d times in a day", n)
	}
}

func TestPolicyValidationAndPersistence(t *testing.T) {
	dir := t.TempDir()
	store := NewPolicyStore(dir)
	bad := []map[string]any{
		{"maxRestartsPerHour": 61.0},
		{"maxRestartsPerHour": 1.5},
		{"backoffSeconds": []any{}},
		{"backoffSeconds": []any{-1.0}},
		{"instances": map[string]any{"alas": map[string]any{"autoRestart": "yes"}}},
		{"instances": map[string]any{"alas": map[string]any{"stallMinutes": true}}},
		{"instances": map[string]any{"alas": map[string]any{"nope": 1.0}}},
		{"nope": 1.0},
	}
	for _, b := range bad {
		if _, err := store.Update(b); err == nil {
			t.Errorf("accepted %v", b)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, PolicyFile)); err == nil {
		t.Fatal("invalid change was written")
	}
	if _, err := store.Update(map[string]any{"maxRestartsPerHour": 5.0,
		"instances": map[string]any{"alas": map[string]any{"stallMinutes": 10.0}}}); err != nil {
		t.Fatal(err)
	}
	store.Update(map[string]any{"instances": map[string]any{"alas": map[string]any{"restartOnStall": true}}})
	reloaded := NewPolicyStore(dir)
	ip := reloaded.Instance("alas")
	if reloaded.Get().MaxRestartsPerHour != 5 || ip.StallMinutes != 10 || !ip.RestartOnStall || !ip.AutoRestart {
		t.Fatalf("persisted %+v %+v", reloaded.Get(), ip)
	}
}

func TestChecks(t *testing.T) {
	m, _, _ := setup(t, crashed())
	if c := m.Checks(); c.Status != "warn" {
		t.Fatalf("before the first tick: %+v", c)
	}
	m.Tick()
	c := m.Checks()
	if c.Status != "fail" || c.Checks[len(c.Checks)-1].Name != "instance:alas" {
		t.Fatalf("checks %+v", c)
	}
}

func TestBackgroundLoopStops(t *testing.T) {
	m, _, _ := setup(t, worker.Status{ID: "alas", State: "stopped"})
	m.Interval = 10 * time.Millisecond
	m.Start()
	time.Sleep(50 * time.Millisecond)
	m.Stop()
	if m.InstanceHealth("alas") == nil {
		t.Fatal("loop never ticked")
	}
}
