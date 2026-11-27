// Package worker owns the Python worker process of each Alas instance.
//
// A worker is `python -m module.control.worker <instance> <func>`. It writes its log as JSON lines
// on stdout ({"log": "..."}), reads "stop" on stdin, and exits with Alas' exit codes. The manager
// keeps a bounded plain-text log tail, derives the current task from the log, and reports the
// state the dashboard shows. Its logic follows module/webui/process_manager.py.
package worker

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"alasd/internal/timeutil"
)

const (
	LogTailLines   = 2000
	LogLineMaxSize = 16 * 1024
	// Exit codes of the worker, see module/exception.py and module/control/worker.py
	HumanTakeoverExitCode  = 10
	RetryLaterExitCode     = 11
	AlreadyRunningExitCode = 75
)

var (
	taskStart = regexp.MustCompile("Scheduler: Start task `([^`]+)`")
	taskEnd   = "Scheduler: End task"
)

// Config of how workers are started.
type Config struct {
	Root   string   // ALAS root folder, working directory of the workers
	Python []string // interpreter command, e.g. [".venv/Scripts/python.exe"]
	// Seconds a worker gets to stop by itself before it is killed
	GracefulStop time.Duration
	// How long to wait for the log of an exited worker
	DrainTimeout time.Duration
	// Command line of a worker, defaults to python -m module.control.worker <id> <func>
	Command func(id, fn string) []string
}

// LogLine is one entry of the log tail.
type LogLine struct {
	Seq  int64  `json:"seq"`
	Text string `json:"text"`
}

// LogChunk is the answer of LogSince.
type LogChunk struct {
	Lines   []LogLine `json:"lines"`
	LastSeq int64     `json:"lastSeq"`
}

// Status is the API view of an instance (InstanceStatus in openapi.json, without health).
type Status struct {
	ID             string  `json:"id"`
	State          string  `json:"state"`
	ProcessID      *int    `json:"processId"`
	StartedAt      *string `json:"startedAt"`
	StoppedAt      *string `json:"stoppedAt"`
	ExitCode       *int    `json:"exitCode"`
	CurrentTask    *string `json:"currentTask"`
	LastActivityAt *string `json:"lastActivityAt"`
	LastError      *string `json:"lastError"`
	LegacyState    int     `json:"legacyState"`
	Revision       int     `json:"revision"`
	RunLogStartSeq int64   `json:"runLogStartSeq"`
	LogDraining    bool    `json:"logDraining"`
	Unmanaged      bool    `json:"unmanaged"`
	TaskSuccesses  int     `json:"taskSuccesses"`
	TaskFailures   int     `json:"taskFailures"`
}

type run struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	exited   chan struct{} // closed when the process exited
	drained  chan struct{} // closed when its log was read to the end (or given up)
	exitCode int
	stderr   []string // last lines of stderr, shown if the worker dies before logging
	logged   bool
}

// Manager of one instance. Lifecycle calls (Start, Stop, Restart) are serialised by lifecycle;
// fields are guarded by mu, so Status never waits for a running start or stop.
type Manager struct {
	ID       string
	cfg      Config
	lockPath string

	lifecycle sync.Mutex

	mu             sync.Mutex
	run            *run
	transition     string
	stopRequested  bool
	exitObserved   bool
	revision       int
	startedAt      *time.Time
	stoppedAt      *time.Time
	lastActivityAt *time.Time
	currentTask    string
	lastLine       string
	tail           []LogLine
	logSeq         int64
	runLogStartSeq int64
	taskSuccesses  int
	taskFailures   int
}

func NewManager(id string, cfg Config) *Manager {
	if cfg.GracefulStop == 0 {
		cfg.GracefulStop = 3 * time.Second
	}
	if cfg.DrainTimeout == 0 {
		cfg.DrainTimeout = 2 * time.Second
	}
	return &Manager{ID: id, cfg: cfg, lockPath: LockPath(cfg.Root, id), exitObserved: true}
}

func (m *Manager) command(fn string) []string {
	if m.cfg.Command != nil {
		return m.cfg.Command(m.ID, fn)
	}
	return append(append([]string{}, m.cfg.Python...), "-m", "module.control.worker", m.ID, fn)
}

// aliveLocked: the worker process is running. Needs mu.
func (m *Manager) aliveLocked() bool {
	if m.run == nil {
		return false
	}
	select {
	case <-m.run.exited:
		return false
	default:
		return true
	}
}

// Alive tells if the worker process runs.
func (m *Manager) Alive() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.aliveLocked()
}

// Start the worker unless it already runs. Returns if a new worker was started.
func (m *Manager) Start(fn string) (bool, error) {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	return m.start(fn)
}

func (m *Manager) start(fn string) (bool, error) {
	m.mu.Lock()
	if m.aliveLocked() {
		m.mu.Unlock()
		return false, nil
	}
	previous := m.run
	m.mu.Unlock()
	if HeldElsewhere(m.lockPath) {
		return false, nil
	}
	if previous != nil {
		// Let the log of the previous run finish, so runLogStartSeq separates the runs
		select {
		case <-previous.drained:
		case <-time.After(m.cfg.DrainTimeout):
		}
	}

	m.mu.Lock()
	m.transition = "starting"
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.transition = ""
		m.mu.Unlock()
	}()

	argv := m.command(fn)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = m.cfg.Root
	cmd.Env = append(os.Environ(), "PYTHONIOENCODING=utf-8", "PYTHONUNBUFFERED=1")
	Detach(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return false, err
	}
	// Own pipes instead of cmd.Wait: grandchildren (adb server, emulator tools) can inherit
	// stderr and keep it open long after the worker exited.
	outR, outW, err := os.Pipe()
	if err != nil {
		return false, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return false, err
	}
	cmd.Stdout = outW
	cmd.Stderr = errW
	if err := cmd.Start(); err != nil {
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		stdin.Close()
		return false, fmt.Errorf("start worker: %w", err)
	}
	outW.Close()
	errW.Close()

	r := &run{cmd: cmd, stdin: stdin, exited: make(chan struct{}), drained: make(chan struct{})}
	now := time.Now()
	m.mu.Lock()
	m.run = r
	m.runLogStartSeq = m.logSeq
	m.stopRequested = false
	m.exitObserved = false
	m.startedAt = &now
	m.stoppedAt = nil
	m.currentTask = ""
	m.revision++
	m.mu.Unlock()

	outDone := make(chan struct{})
	go func() {
		defer close(outDone)
		m.readProtocol(r, outR)
	}()
	errDone := make(chan struct{})
	go func() {
		defer close(errDone)
		m.readStderr(r, errR)
	}()
	go func() {
		state, _ := cmd.Process.Wait()
		code := -1
		if state != nil {
			code = state.ExitCode()
		}
		m.mu.Lock()
		r.exitCode = code
		m.mu.Unlock()
		close(r.exited)
		// Give the readers the rest of the log, then unblock them
		select {
		case <-outDone:
		case <-time.After(m.cfg.DrainTimeout):
			outR.Close()
		}
		select {
		case <-errDone:
		case <-time.After(m.cfg.DrainTimeout / 2):
			errR.Close()
		}
		m.mu.Lock()
		if code != 0 && !m.stopRequested && !r.logged && len(r.stderr) > 0 {
			// Died before its logger worked (import error, bad interpreter): show why
			for _, line := range r.stderr {
				m.appendLocked(line)
			}
		}
		m.observeExitLocked(r)
		m.mu.Unlock()
		close(r.drained)
	}()
	return true, nil
}

func (m *Manager) readProtocol(r *run, rd io.Reader) {
	sc := bufio.NewScanner(rd)
	sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for sc.Scan() {
		var msg struct {
			Log *string `json:"log"`
		}
		line := sc.Bytes()
		if err := json.Unmarshal(line, &msg); err != nil || msg.Log == nil {
			m.trackActivity(r, string(line))
			continue
		}
		m.trackActivity(r, *msg.Log)
	}
}

func (m *Manager) readStderr(r *run, rd io.Reader) {
	sc := bufio.NewScanner(rd)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		log.Printf("[%s] %s", m.ID, line)
		m.mu.Lock()
		r.stderr = append(r.stderr, line)
		if len(r.stderr) > 30 {
			r.stderr = r.stderr[len(r.stderr)-30:]
		}
		m.mu.Unlock()
	}
}

func (m *Manager) trackActivity(r *run, text string) {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	r.logged = true
	m.lastActivityAt = &now
	m.appendLocked(text)
	if match := taskStart.FindStringSubmatch(text); match != nil {
		m.currentTask = match[1]
	} else if strings.Contains(text, taskEnd) {
		m.currentTask = ""
		trimmed := strings.TrimRight(text, " \t\r\n")
		if strings.HasSuffix(trimmed, "[success]") {
			m.taskSuccesses++
		} else if strings.HasSuffix(trimmed, "[failure]") {
			m.taskFailures++
		}
	}
}

// appendLocked adds one log entry to the tail. Needs mu.
func (m *Manager) appendLocked(text string) {
	text = strings.TrimRight(text, "\n")
	if len(text) > LogLineMaxSize {
		cut := LogLineMaxSize - 3
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		text = text[:cut] + "…"
	}
	text = strings.ToValidUTF8(text, "�")
	m.logSeq++
	m.tail = append(m.tail, LogLine{Seq: m.logSeq, Text: text})
	if len(m.tail) > LogTailLines {
		// Amortised trim
		m.tail = append([]LogLine(nil), m.tail[len(m.tail)-LogTailLines:]...)
	}
	m.lastLine = text
}

func (m *Manager) observeExitLocked(r *run) {
	if m.run == r && !m.exitObserved {
		m.exitObserved = true
		now := time.Now()
		m.stoppedAt = &now
		m.revision++
	}
}

// Stop asks the worker to stop, then kills it. Returns if no worker runs afterwards.
func (m *Manager) Stop() bool {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	return m.stop()
}

func (m *Manager) stop() bool {
	m.mu.Lock()
	r := m.run
	wasAlive := m.aliveLocked()
	if wasAlive {
		m.transition = "stopping"
		m.stopRequested = true
		m.revision++
	} else if r != nil && !m.stopRequested {
		m.stopRequested = true
		m.revision++
	}
	m.mu.Unlock()

	if wasAlive {
		_, _ = io.WriteString(r.stdin, "stop\n")
		select {
		case <-r.exited:
		case <-time.After(m.cfg.GracefulStop):
			_ = r.cmd.Process.Kill()
			select {
			case <-r.exited:
			case <-time.After(10 * time.Second):
				log.Printf("[%s] still alive 10s after kill", m.ID)
			}
		}
		_ = r.stdin.Close()
		select {
		case <-r.drained:
		case <-time.After(m.cfg.DrainTimeout + time.Second):
		}
		m.mu.Lock()
		m.transition = ""
		m.observeExitLocked(r)
		if !m.aliveLocked() {
			m.appendLocked(fmt.Sprintf("[%s] exited. Reason: Manual stop", m.ID))
		}
		m.mu.Unlock()
	}
	log.Printf("[%s] exited", m.ID)
	return !m.Alive() && !HeldElsewhere(m.lockPath)
}

// Restart stops the worker if it runs, then starts a new one, with nothing in between.
func (m *Manager) Restart(fn string) (bool, error) {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	if !m.stop() {
		return false, nil
	}
	return m.start(fn)
}

// Recover restarts (stalled) or starts the worker if its status still equals expected,
// so a recovery never acts on a state that changed meanwhile. Returns nil if it did nothing.
func (m *Manager) Recover(expected Status, restart bool, fn string) (*Status, error) {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	current := m.Status()
	same := current.Revision == expected.Revision && current.State == expected.State &&
		eqStr(current.CurrentTask, expected.CurrentTask) && eqStr(current.LastActivityAt, expected.LastActivityAt) &&
		current.Unmanaged == expected.Unmanaged
	if !same {
		return nil, nil
	}
	var err error
	if restart {
		if m.stop() {
			_, err = m.start(fn)
		}
	} else {
		_, err = m.start(fn)
	}
	status := m.Status()
	return &status, err
}

func eqStr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// LogSince returns lines with seq > after, the newest `limit` of them.
func (m *Manager) LogSince(after int64, limit int) LogChunk {
	m.mu.Lock()
	defer m.mu.Unlock()
	start := len(m.tail)
	for start > 0 && m.tail[start-1].Seq > after {
		start--
	}
	lines := m.tail[start:]
	if limit > 0 && len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return LogChunk{Lines: append([]LogLine{}, lines...), LastSeq: m.logSeq}
}

// CurrentTask of a running worker, "" when none.
func (m *Manager) CurrentTask() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.aliveLocked() {
		return ""
	}
	return m.currentTask
}

// Status snapshot of the instance. Never waits for a start or stop.
func (m *Manager) Status() Status {
	m.mu.Lock()
	r := m.run
	alive := m.aliveLocked()
	transition := m.transition
	m.mu.Unlock()
	unmanaged := !alive && transition == "" && HeldElsewhere(m.lockPath)

	m.mu.Lock()
	defer m.mu.Unlock()
	s := Status{
		ID:             m.ID,
		StartedAt:      timeutil.ISOPtr(m.startedAt),
		LastActivityAt: timeutil.ISOPtr(m.lastActivityAt),
		LegacyState:    m.legacyStateLocked(alive),
		Revision:       m.revision,
		RunLogStartSeq: m.runLogStartSeq,
		Unmanaged:      unmanaged,
		TaskSuccesses:  m.taskSuccesses,
		TaskFailures:   m.taskFailures,
	}
	if !alive {
		s.StoppedAt = timeutil.ISOPtr(m.stoppedAt)
	}
	var exitCode *int
	if r != nil && !alive {
		code := r.exitCode
		exitCode = &code
		select {
		case <-r.drained:
		default:
			s.LogDraining = true
		}
	}
	s.ExitCode = exitCode
	if alive {
		pid := r.cmd.Process.Pid
		s.ProcessID = &pid
		if m.currentTask != "" {
			task := m.currentTask
			s.CurrentTask = &task
		}
	}
	switch {
	case transition != "":
		s.State = transition
	case alive || unmanaged:
		s.State = "running"
		if unmanaged {
			msg := "Worker is owned by an earlier ALAS server or another launcher"
			s.LastError = &msg
		}
	case r == nil || m.stopRequested:
		s.State = "stopped"
	case exitCode != nil && *exitCode != 0:
		s.State = "failed"
		msg := fmt.Sprintf("Worker exited with code %d", *exitCode)
		if *exitCode == AlreadyRunningExitCode {
			msg = "Worker is owned by an earlier ALAS server or another launcher"
		}
		s.LastError = &msg
	default:
		s.State = "stopped"
	}
	return s
}

// legacyStateLocked is the state number of the PyWebIO GUI: 1 running, 2 stopped or finished,
// 3 error, 4 update.
func (m *Manager) legacyStateLocked(alive bool) int {
	switch {
	case alive:
		return 1
	case m.stopRequested || m.lastLine == "":
		return 2
	}
	last := strings.TrimSpace(m.lastLine)
	switch {
	case strings.HasSuffix(last, "Reason: Manual stop"), strings.HasSuffix(last, "Reason: Finish"):
		return 2
	case strings.HasSuffix(last, "Reason: Update"):
		return 4
	}
	return 3
}

// Registry of managers, one per instance.
type Registry struct {
	cfg      Config
	mu       sync.Mutex
	managers map[string]*Manager
}

func NewRegistry(cfg Config) *Registry {
	return &Registry{cfg: cfg, managers: map[string]*Manager{}}
}

// Get the manager of an instance, created on first use.
func (r *Registry) Get(id string) *Manager {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.managers[id]
	if !ok {
		m = NewManager(id, r.cfg)
		r.managers[id] = m
	}
	return m
}

// All managers created so far.
func (r *Registry) All() []*Manager {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Manager, 0, len(r.managers))
	for _, m := range r.managers {
		out = append(out, m)
	}
	return out
}
