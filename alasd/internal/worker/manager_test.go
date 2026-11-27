package worker

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The test binary doubles as a fake worker: FAKE_WORKER=1 makes TestMain run fakeWorker.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_WORKER") == "1" {
		fakeWorker()
		return
	}
	os.Exit(m.Run())
}

func logLine(text string) {
	b, _ := json.Marshal(map[string]string{"log": text})
	fmt.Println(string(b))
}

// fakeWorker behaviour from FAKE_MODE: "run" logs a task and runs until "stop", "exit=N" logs
// and exits with N, "deaf" ignores stop, "stderr" dies with a traceback on stderr.
func fakeWorker() {
	mode := os.Getenv("FAKE_MODE")
	switch {
	case strings.HasPrefix(mode, "exit="):
		code, _ := strconv.Atoi(strings.TrimPrefix(mode, "exit="))
		logLine("Scheduler: Start task `Commission`")
		logLine("Scheduler: End task `Commission` [success]")
		if code == 10 {
			logLine("CRITICAL Request human takeover")
		}
		os.Exit(code)
	case mode == "stderr":
		fmt.Fprintln(os.Stderr, "Traceback (most recent call last):")
		fmt.Fprintln(os.Stderr, "ModuleNotFoundError: No module named 'numpy'")
		os.Exit(1)
	}
	logLine("Smoke worker ready")
	logLine("Scheduler: Start task `Commission`")
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		if sc.Text() == "stop" && mode != "deaf" {
			logLine("[fake] exited. Reason: Finish")
			os.Exit(0)
		}
	}
	if mode == "deaf" {
		time.Sleep(time.Hour)
	}
	os.Exit(0)
}

func newTestManager(t *testing.T, mode string) *Manager {
	t.Helper()
	root := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_WORKER", "1")
	t.Setenv("FAKE_MODE", mode)
	m := NewManager("alas", Config{
		Root:         root,
		GracefulStop: 500 * time.Millisecond,
		DrainTimeout: 500 * time.Millisecond,
		Command:      func(id, fn string) []string { return []string{exe} },
	})
	t.Cleanup(func() { m.Stop() })
	return m
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestStartStop(t *testing.T) {
	m := newTestManager(t, "run")
	if s := m.Status(); s.State != "stopped" || s.ProcessID != nil || s.LegacyState != 2 {
		t.Fatalf("initial status %+v", s)
	}
	started, err := m.Start("alas")
	if err != nil || !started {
		t.Fatalf("start: %v %v", started, err)
	}
	waitFor(t, "current task", func() bool { return m.Status().CurrentTask != nil })
	s := m.Status()
	if s.State != "running" || *s.CurrentTask != "Commission" || s.ProcessID == nil || s.LastActivityAt == nil {
		t.Fatalf("running status %+v", s)
	}
	if again, _ := m.Start("alas"); again {
		t.Fatal("second start created another worker")
	}
	if !m.Stop() {
		t.Fatal("stop reported a running worker")
	}
	s = m.Status()
	if s.State != "stopped" || s.ProcessID != nil || s.CurrentTask != nil || s.StoppedAt == nil {
		t.Fatalf("stopped status %+v", s)
	}
	lines := m.LogSince(0, 0).Lines
	if last := lines[len(lines)-1].Text; last != "[alas] exited. Reason: Manual stop" {
		t.Fatalf("last line %q", last)
	}
	if !m.Stop() {
		t.Fatal("stop when stopped must be safe")
	}
}

func TestDeafWorkerIsKilled(t *testing.T) {
	m := newTestManager(t, "deaf")
	m.Start("alas")
	waitFor(t, "ready", func() bool { return len(m.LogSince(0, 0).Lines) > 0 })
	begin := time.Now()
	if !m.Stop() {
		t.Fatal("deaf worker survived")
	}
	if time.Since(begin) > 5*time.Second {
		t.Fatal("kill took too long")
	}
	if s := m.Status(); s.State != "stopped" {
		t.Fatalf("status %+v", s)
	}
}

func TestExitCodes(t *testing.T) {
	cases := []struct {
		mode, state string
		legacy      int
	}{
		{"exit=0", "stopped", 3},
		{"exit=1", "failed", 3},
		{"exit=10", "failed", 3},
		{"exit=75", "failed", 3},
	}
	for _, c := range cases {
		t.Run(c.mode, func(t *testing.T) {
			m := newTestManager(t, c.mode)
			m.Start("alas")
			waitFor(t, "exit", func() bool {
				s := m.Status()
				return s.State != "running" && s.State != "starting" && !s.LogDraining
			})
			s := m.Status()
			if s.State != c.state {
				t.Fatalf("state %s, want %s (%+v)", s.State, c.state, s)
			}
			if s.TaskSuccesses != 1 || s.CurrentTask != nil {
				t.Fatalf("task tracking %+v", s)
			}
			if c.mode == "exit=75" && !strings.Contains(*s.LastError, "owned by") {
				t.Fatalf("lastError %v", *s.LastError)
			}
		})
	}
}

func TestStderrShownWhenWorkerDiesBeforeLogging(t *testing.T) {
	m := newTestManager(t, "stderr")
	m.Start("alas")
	waitFor(t, "exit", func() bool { s := m.Status(); return s.State == "failed" && !s.LogDraining })
	lines := m.LogSince(0, 0).Lines
	if len(lines) != 2 || !strings.Contains(lines[1].Text, "No module named") {
		t.Fatalf("lines %+v", lines)
	}
}

func TestRestartNeverRunsTwoWorkers(t *testing.T) {
	m := newTestManager(t, "run")
	m.Start("alas")
	waitFor(t, "ready", func() bool { return m.Status().CurrentTask != nil })
	first := *m.Status().ProcessID
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.Restart("alas")
		}()
	}
	wg.Wait()
	s := m.Status()
	if s.State != "running" || *s.ProcessID == first {
		t.Fatalf("status %+v", s)
	}
}

func TestRecoverOnlyWhenUnchanged(t *testing.T) {
	m := newTestManager(t, "exit=1")
	m.Start("alas")
	waitFor(t, "crash", func() bool { s := m.Status(); return s.State == "failed" && !s.LogDraining })
	stale := m.Status()
	stale.Revision--
	if got, _ := m.Recover(stale, false, "alas"); got != nil {
		t.Fatal("recovered from a stale status")
	}
	if got, _ := m.Recover(m.Status(), false, "alas"); got == nil {
		t.Fatal("did not recover")
	}
}

func TestLogTailBoundsAndPaging(t *testing.T) {
	m := NewManager("alas", Config{Root: t.TempDir()})
	m.mu.Lock()
	for i := 0; i < LogTailLines+10; i++ {
		m.appendLocked(fmt.Sprintf("line %d", i))
	}
	m.appendLocked(strings.Repeat("é", LogLineMaxSize))
	m.mu.Unlock()
	all := m.LogSince(0, 0)
	if len(all.Lines) != LogTailLines || all.LastSeq != LogTailLines+11 {
		t.Fatalf("tail %d lines, last %d", len(all.Lines), all.LastSeq)
	}
	long := all.Lines[len(all.Lines)-1].Text
	if len(long) > LogLineMaxSize || !strings.HasSuffix(long, "…") {
		t.Fatalf("long line not cut: %d", len(long))
	}
	page := m.LogSince(all.LastSeq-3, 2)
	if len(page.Lines) != 2 || page.Lines[1].Seq != all.LastSeq {
		t.Fatalf("page %+v", page.Lines)
	}
	if empty := m.LogSince(all.LastSeq, 10); len(empty.Lines) != 0 {
		t.Fatal("lines after the end")
	}
}

func TestLockHeldElsewhere(t *testing.T) {
	root := t.TempDir()
	path := LockPath(root, "alas")
	if HeldElsewhere(path) {
		t.Fatal("free lock reported held")
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if ok, err := tryLock(f); !ok || err != nil {
		t.Fatal("cannot lock")
	}
	// flock locks are per open file description: a second open sees it held
	if !HeldElsewhere(path) {
		t.Fatal("held lock reported free")
	}
	m := NewManager("alas", Config{Root: root})
	if s := m.Status(); !s.Unmanaged || s.State != "running" {
		t.Fatalf("status %+v", s)
	}
	if started, _ := m.Start("alas"); started {
		t.Fatal("started while another process owns the instance")
	}
	unlock(f)
}
