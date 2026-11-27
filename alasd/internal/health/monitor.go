// Package health checks the instances and recovers them within bounds (module/control/health.py).
//
// Signals per instance:
//   - crashed        the worker exited on its own with an error
//   - human_takeover the worker stopped on RequestHumanTakeover: it needs a person, never restarted
//   - waiting_retry  the game could not log in (maintenance, update): woken every WakeMinutes
//   - stalled        a task runs but the worker logged nothing for stallMinutes
//   - idle           the worker waits for its next task (healthy)
//   - ok / stopped   healthy
//
// Restarts back off and stop after maxRestartsPerHour; the instance is then marked gaveUp until
// someone starts it again. Deliberate stops, natural finishes and updates are never failures.
package health

import (
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"alasd/internal/instances"
	"alasd/internal/timeutil"
	"alasd/internal/worker"
)

const (
	HistoryLength        = 200
	HealthyResetSeconds  = 600
	WakeMinutes          = 60
	WakeForHours         = 24
	WakeResetSeconds     = 1800
	defaultCheckInterval = 5 * time.Second
)

var humanTakeoverMarkers = []string{"Request human takeover", "RequestHumanTakeover"}

// Recovery view of an instance (InstanceRecovery).
type Recovery struct {
	Policy           InstancePolicy `json:"policy"`
	RestartsLastHour int            `json:"restartsLastHour"`
	NextAttemptAt    *string        `json:"nextAttemptAt"`
	PendingReason    *string        `json:"pendingReason"`
	GaveUp           bool           `json:"gaveUp"`
}

// InstanceHealth (InstanceHealth in openapi.json).
type InstanceHealth struct {
	State    string   `json:"state"`
	Detail   string   `json:"detail"`
	Recovery Recovery `json:"recovery"`
}

// Event of the recovery history.
type Event struct {
	Time       string `json:"time"`
	InstanceID string `json:"instanceId"`
	Action     string `json:"action"`
	Reason     string `json:"reason"`
	Detail     string `json:"detail"`
}

type Check struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type Checks struct {
	Status string  `json:"status"`
	Checks []Check `json:"checks"`
}

type recovery struct {
	restarts      []time.Time
	consecutive   int
	nextAttemptAt *time.Time
	pendingReason string
	gaveUpAt      *time.Time
	lastRestartAt *time.Time
	waitingSince  *time.Time
	wakeAt        *time.Time
}

// Service is what the monitor needs from the instances.
type Service interface {
	Statuses() []instances.Status
	Logs(id string, after int64, limit int) (worker.LogChunk, error)
	Recover(expected worker.Status, reason string) (*worker.Status, error)
}

type Monitor struct {
	Service  Service
	Policy   *PolicyStore
	Interval time.Duration
	Clock    func() time.Time

	mu           sync.Mutex
	history      []Event
	recovery     map[string]*recovery
	health       map[string]InstanceHealth
	lastTickAt   *time.Time
	lastError    string
	RestartCount int
	stop         chan struct{}
	done         chan struct{}
}

func NewMonitor(service Service, policy *PolicyStore) *Monitor {
	return &Monitor{Service: service, Policy: policy, Interval: defaultCheckInterval, Clock: time.Now,
		recovery: map[string]*recovery{}, health: map[string]InstanceHealth{}}
}

// Start checking in the background.
func (m *Monitor) Start() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stop != nil {
		return
	}
	m.stop, m.done = make(chan struct{}), make(chan struct{})
	go m.loop(m.stop, m.done)
}

// Stop checking and recovering. Called before the server stops its workers.
func (m *Monitor) Stop() {
	m.mu.Lock()
	stop, done := m.stop, m.done
	m.stop = nil
	m.mu.Unlock()
	if stop != nil {
		close(stop)
		<-done
	}
}

func (m *Monitor) stopping() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stop == nil && m.done != nil
}

func (m *Monitor) loop(stop, done chan struct{}) {
	defer close(done)
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					m.mu.Lock()
					m.lastError = fmt.Sprint(r)
					m.mu.Unlock()
					log.Printf("health monitor: %v", r)
				}
			}()
			m.Tick()
			m.mu.Lock()
			m.lastError = ""
			m.mu.Unlock()
		}()
		select {
		case <-stop:
			return
		case <-time.After(m.Interval):
		}
	}
}

func (m *Monitor) record(id, action, reason, detail string) {
	e := Event{Time: timeutil.ISO(m.Clock()), InstanceID: id, Action: action, Reason: reason, Detail: detail}
	m.mu.Lock()
	m.history = append(m.history, e)
	if len(m.history) > HistoryLength {
		m.history = m.history[len(m.history)-HistoryLength:]
	}
	m.mu.Unlock()
	log.Printf("[%s] recovery %s: %s", id, action, strings.TrimSpace(reason+" "+detail))
}

type classified struct{ state, detail string }

func intIs(p *int, v int) bool { return p != nil && *p == v }

func (m *Monitor) classify(s worker.Status, policy InstancePolicy, now time.Time) classified {
	if s.Unmanaged {
		detail := ""
		if s.LastError != nil {
			detail = *s.LastError
		}
		return classified{"unmanaged", detail}
	}
	switch s.State {
	case "starting", "stopping":
		return classified{"ok", s.State}
	case "failed":
		if intIs(s.ExitCode, worker.RetryLaterExitCode) {
			return classified{"waiting_retry", "The game could not log in (maintenance or an update)"}
		}
		if intIs(s.ExitCode, worker.HumanTakeoverExitCode) {
			return classified{"human_takeover", "Alas requested human takeover, see the log"}
		}
		if s.LogDraining {
			return classified{"ok", "Reading the worker's final log messages"}
		}
		// Only this run's last lines: an earlier run may have asked for a human
		if chunk, err := m.Service.Logs(s.ID, s.RunLogStartSeq, 30); err == nil {
			for _, line := range chunk.Lines {
				for _, marker := range humanTakeoverMarkers {
					if strings.Contains(line.Text, marker) {
						return classified{"human_takeover", "Alas requested human takeover, see the log"}
					}
				}
			}
		}
		detail := "Worker exited with an error"
		if s.LastError != nil {
			detail = *s.LastError
		}
		return classified{"crashed", detail}
	case "stopped":
		return classified{"stopped", ""}
	}
	last := timeutil.Parse(s.LastActivityAt)
	if last == nil {
		last = timeutil.Parse(s.StartedAt)
	}
	if s.CurrentTask != nil && policy.StallMinutes > 0 && last != nil &&
		now.Sub(*last) > time.Duration(policy.StallMinutes)*time.Minute {
		return classified{"stalled", fmt.Sprintf("Task %s logged nothing for %d min", *s.CurrentTask,
			int(now.Sub(*last).Minutes()))}
	}
	if s.CurrentTask == nil {
		return classified{"idle", "Waiting for the next task"}
	}
	return classified{"ok", "Running " + *s.CurrentTask}
}

// Tick checks every instance once and recovers what the policy allows.
func (m *Monitor) Tick() {
	now := m.Clock()
	policy := m.Policy.Get()
	backoff := policy.BackoffSeconds
	if len(backoff) == 0 {
		backoff = []int{30}
	}
	for _, status := range m.Service.Statuses() {
		s := status.Status
		id := s.ID
		ip := m.Policy.Instance(id)
		h := m.classify(s, ip, now)

		m.mu.Lock()
		rec, ok := m.recovery[id]
		if !ok {
			rec = &recovery{}
			m.recovery[id] = rec
		}
		kept := rec.restarts[:0]
		for _, t := range rec.restarts {
			if now.Sub(t) < time.Hour {
				kept = append(kept, t)
			}
		}
		rec.restarts = kept

		// Someone started it again after we gave up, or it ran healthy long enough
		started := timeutil.Parse(s.StartedAt)
		if rec.gaveUpAt != nil && s.State == "running" && started != nil && started.After(*rec.gaveUpAt) {
			rec.gaveUpAt = nil
			rec.consecutive = 0
		}
		healthy := h.state == "ok" || h.state == "idle"
		if healthy && rec.lastRestartAt != nil && now.Sub(*rec.lastRestartAt) > HealthyResetSeconds*time.Second {
			rec.consecutive = 0
			rec.lastRestartAt = nil
		}
		// A woken worker fails its login within minutes; only a longer healthy run ends the wait
		if healthy && rec.waitingSince != nil && started != nil && now.Sub(*started) > WakeResetSeconds*time.Second {
			rec.waitingSince = nil
		}
		wake := false
		var notes [][3]string
		if h.state == "waiting_retry" && ip.AutoRestart && rec.gaveUpAt == nil {
			wake, notes = m.planWakeLocked(s, rec, now)
		} else {
			rec.wakeAt = nil
		}
		wants := ""
		if h.state == "crashed" && ip.AutoRestart {
			wants = "crashed"
		} else if h.state == "stalled" && ip.RestartOnStall {
			wants = "stalled"
		}
		if wants == "" {
			rec.nextAttemptAt = nil
			rec.pendingReason = ""
		}
		gaveUp := rec.gaveUpAt != nil
		m.mu.Unlock()
		for _, n := range notes {
			m.record(id, n[0], n[1], n[2])
		}

		if wake && !m.stopping() {
			if restarted := m.wake(s, rec); restarted != nil {
				h = m.classify(*restarted, ip, now)
			}
		}
		if wants != "" && !gaveUp {
			if restarted := m.maybeRestart(s, wants, h, rec, now, policy.MaxRestartsPerHour, backoff); restarted != nil {
				h = m.classify(*restarted, ip, now)
			}
		}
		m.mu.Lock()
		m.health[id] = InstanceHealth{State: h.state, Detail: h.detail, Recovery: recoveryView(rec, ip)}
		m.mu.Unlock()
	}
	m.mu.Lock()
	m.lastTickAt = &now
	m.mu.Unlock()
}

func (m *Monitor) maybeRestart(s worker.Status, reason string, h classified, rec *recovery, now time.Time,
	maxRestarts int, backoff []int) *worker.Status {
	id := s.ID
	m.mu.Lock()
	giveUp := len(rec.restarts) >= maxRestarts
	due := false
	scheduled := ""
	if giveUp {
		rec.gaveUpAt = &now
		rec.nextAttemptAt = nil
	} else {
		if rec.nextAttemptAt == nil || rec.pendingReason != reason {
			delay := backoff[min(rec.consecutive, len(backoff)-1)]
			at := now.Add(time.Duration(delay) * time.Second)
			rec.nextAttemptAt = &at
			rec.pendingReason = reason
			scheduled = fmt.Sprintf("restart in %ds (%s)", delay, h.detail)
		}
		due = !rec.nextAttemptAt.After(now)
	}
	m.mu.Unlock()
	if scheduled != "" {
		m.record(id, "scheduled", reason, scheduled)
	}
	if giveUp {
		m.record(id, "gave_up", reason, fmt.Sprintf("%d restarts within an hour, start it manually", maxRestarts))
		return nil
	}
	if !due || m.stopping() {
		return nil
	}
	result, err := m.Service.Recover(s, reason)
	if err == nil && result == nil {
		return nil
	}
	ok := err == nil && (result.State == "starting" || result.State == "running") && !result.Unmanaged
	errText := ""
	if err != nil {
		errText = err.Error()
	} else if !ok && result.LastError != nil {
		errText = *result.LastError
	}
	m.mu.Lock()
	if ok {
		m.RestartCount++
	}
	rec.restarts = append(rec.restarts, now)
	rec.consecutive++
	rec.lastRestartAt = &now
	rec.nextAttemptAt = nil
	rec.pendingReason = ""
	attempts := len(rec.restarts)
	m.mu.Unlock()
	action, detail := "restarted", fmt.Sprintf("attempt %d/%d", attempts, maxRestarts)
	if !ok {
		action, detail = "restart_failed", detail+": "+errText
	}
	m.record(id, action, reason, detail)
	return result
}

// planWakeLocked: if the worker that could not log in should be started now, and the history
// entries to record once mu is released. Needs mu.
func (m *Monitor) planWakeLocked(s worker.Status, rec *recovery, now time.Time) (bool, [][3]string) {
	var notes [][3]string
	stopped := now
	if t := timeutil.Parse(s.StoppedAt); t != nil {
		stopped = *t
	}
	if rec.waitingSince == nil {
		rec.waitingSince = &stopped
	}
	if rec.wakeAt == nil {
		if now.Sub(*rec.waitingSince) > WakeForHours*time.Hour {
			rec.gaveUpAt = &now
			notes = append(notes, [3]string{"gave_up", "waiting_retry",
				fmt.Sprintf("the game could not log in for %d hours, start it manually", WakeForHours)})
			return false, notes
		}
		at := stopped.Add(WakeMinutes * time.Minute)
		rec.wakeAt = &at
		notes = append(notes, [3]string{"scheduled", "waiting_retry", "check again at " + timeutil.ISO(at)})
	}
	return !rec.wakeAt.After(now), notes
}

func (m *Monitor) wake(s worker.Status, rec *recovery) *worker.Status {
	result, err := m.Service.Recover(s, "waiting_retry")
	errText := ""
	if err != nil {
		errText = err.Error()
	} else if result != nil && result.LastError != nil {
		errText = *result.LastError
	}
	m.mu.Lock()
	rec.wakeAt = nil
	m.mu.Unlock()
	ok := result != nil && (result.State == "starting" || result.State == "running")
	detail := "checking if the game can log in"
	action := "restarted"
	if !ok {
		action, detail = "restart_failed", detail+": "+errText
	}
	m.record(s.ID, action, "waiting_retry", detail)
	return result
}

func recoveryView(rec *recovery, ip InstancePolicy) Recovery {
	v := Recovery{Policy: ip, RestartsLastHour: len(rec.restarts), GaveUp: rec.gaveUpAt != nil}
	if rec.wakeAt != nil {
		v.NextAttemptAt = timeutil.ISOPtr(rec.wakeAt)
		reason := "waiting_retry"
		v.PendingReason = &reason
	} else {
		v.NextAttemptAt = timeutil.ISOPtr(rec.nextAttemptAt)
		if rec.pendingReason != "" {
			reason := rec.pendingReason
			v.PendingReason = &reason
		}
	}
	return v
}

// InstanceHealth of an instance, nil before the first check.
func (m *Monitor) InstanceHealth(id string) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	h, ok := m.health[id]
	if !ok {
		return nil
	}
	return h
}

// Checks of the server and of every instance.
func (m *Monitor) Checks() Checks {
	now := m.Clock()
	checks := []Check{
		{Name: "server", Status: "ok", Detail: fmt.Sprintf("pid %d", os.Getpid())},
		// Kept for the dashboard: workers send their logs over their own pipes now
		{Name: "logQueueManager", Status: "ok", Detail: "Workers send their logs over their stdout pipes"},
	}
	m.mu.Lock()
	monitor := Check{Name: "healthMonitor", Status: "ok"}
	switch {
	case m.lastError != "":
		monitor.Status, monitor.Detail = "fail", m.lastError
	case m.lastTickAt == nil:
		monitor.Status, monitor.Detail = "warn", "not checked yet"
	default:
		age := now.Sub(*m.lastTickAt)
		if age > m.Interval*3+5*time.Second {
			monitor.Status = "warn"
		}
		monitor.Detail = fmt.Sprintf("last check %ds ago", int(age.Seconds()))
	}
	checks = append(checks, monitor)
	ids := make([]string, 0, len(m.health))
	for id := range m.health {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		h := m.health[id]
		status := "ok"
		switch {
		case h.State == "crashed" || h.State == "human_takeover" || h.Recovery.GaveUp:
			status = "fail"
		case h.State == "stalled" || h.State == "unmanaged" || h.State == "waiting_retry":
			status = "warn"
		}
		detail := h.State
		if h.Detail != "" {
			detail += ": " + h.Detail
		}
		checks = append(checks, Check{Name: "instance:" + id, Status: status, Detail: detail})
	}
	m.mu.Unlock()
	overall := "ok"
	for _, c := range checks {
		if c.Status == "fail" {
			overall = "fail"
			break
		}
		if c.Status == "warn" {
			overall = "warn"
		}
	}
	return Checks{Status: overall, Checks: checks}
}

// Snapshot of the policy and the recovery history, newest first.
func (m *Monitor) Snapshot() map[string]any {
	policy := m.Policy.Get()
	m.mu.Lock()
	defer m.mu.Unlock()
	history := make([]Event, len(m.history))
	for i, e := range m.history {
		history[len(m.history)-1-i] = e
	}
	return map[string]any{"policy": policy, "history": history}
}
