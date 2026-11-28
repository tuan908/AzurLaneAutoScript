// Package instances is the application view of Alas instances: the configured profiles and the
// worker of each one (module/control/instances.py).
package instances

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"alasd/internal/sidecar"
	"alasd/internal/worker"
)

// UnknownInstance: no profile with that name.
type UnknownInstance struct{ ID string }

func (e UnknownInstance) Error() string { return fmt.Sprintf("No instance named %q", e.ID) }

// Instance is a configured profile and the function its worker runs ("alas" or a mod name).
type Instance struct {
	ID   string `json:"id"`
	Func string `json:"func"`
}

// Status of an instance with its health.
type Status struct {
	worker.Status
	Health any `json:"health"`
}

// Task in the scheduler queue.
type Task struct {
	Command string  `json:"command"`
	NextRun *string `json:"nextRun"`
}

// Tasks of an instance.
type Tasks struct {
	Running []Task `json:"running"`
	Pending []Task `json:"pending"`
	Waiting []Task `json:"waiting"`
}

type Service struct {
	Root    string
	Workers *worker.Registry
	Config  *sidecar.Client
	// Health of an instance, set by the health monitor; nil value means no health yet
	Health func(id string) any
}

// List the configured instances like module.config.utils.alas_instance(): config/<name>.json for
// Alas, config/<name>.<mod>.json for mods, "alas" when there is none.
func (s *Service) List() []Instance {
	entries, _ := os.ReadDir(filepath.Join(s.Root, "config"))
	var alas, mods []Instance
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || filepath.Ext(name) != ".json" {
			continue
		}
		base := strings.TrimSuffix(name, ".json")
		mod := strings.TrimPrefix(filepath.Ext(base), ".")
		configName := strings.TrimSuffix(base, filepath.Ext(base))
		if mod == "" {
			if base != "template" {
				alas = append(alas, Instance{ID: base, Func: "alas"})
			}
		} else if configName != "template" {
			mods = append(mods, Instance{ID: configName, Func: mod})
		}
	}
	sort.Slice(alas, func(i, j int) bool { return alas[i].ID < alas[j].ID })
	sort.Slice(mods, func(i, j int) bool { return mods[i].ID < mods[j].ID })
	out := append(alas, mods...)
	if len(out) == 0 {
		out = []Instance{{ID: "alas", Func: "alas"}}
	}
	return out
}

func (s *Service) find(id string) (Instance, error) {
	for _, inst := range s.List() {
		if inst.ID == id {
			return inst, nil
		}
	}
	return Instance{}, UnknownInstance{id}
}

// Require fails with UnknownInstance if id is not configured.
func (s *Service) Require(id string) error {
	_, err := s.find(id)
	return err
}

// Func run by the worker of an instance.
func (s *Service) Func(id string) string {
	inst, err := s.find(id)
	if err != nil {
		return "alas"
	}
	return inst.Func
}

func (s *Service) status(m *worker.Manager) Status {
	st := Status{Status: m.Status()}
	if s.Health != nil {
		st.Health = s.Health(m.ID)
	}
	return st
}

// Statuses of all instances.
func (s *Service) Statuses() []Status {
	list := s.List()
	out := make([]Status, 0, len(list))
	for _, inst := range list {
		out = append(out, s.status(s.Workers.Get(inst.ID)))
	}
	return out
}

func (s *Service) Get(id string) (Status, error) {
	if err := s.Require(id); err != nil {
		return Status{}, err
	}
	return s.status(s.Workers.Get(id)), nil
}

func (s *Service) Start(id string) (Status, error) {
	inst, err := s.find(id)
	if err != nil {
		return Status{}, err
	}
	m := s.Workers.Get(id)
	if _, err := m.Start(inst.Func); err != nil {
		return Status{}, err
	}
	return s.status(m), nil
}

func (s *Service) Stop(id string) (Status, error) {
	if err := s.Require(id); err != nil {
		return Status{}, err
	}
	m := s.Workers.Get(id)
	m.Stop()
	return s.status(m), nil
}

func (s *Service) Restart(id string) (Status, error) {
	inst, err := s.find(id)
	if err != nil {
		return Status{}, err
	}
	m := s.Workers.Get(id)
	if _, err := m.Restart(inst.Func); err != nil {
		return Status{}, err
	}
	return s.status(m), nil
}

// Recover restarts (reason "stalled") or starts the worker if its status is still expected.
func (s *Service) Recover(expected worker.Status, reason string) (*worker.Status, error) {
	inst, err := s.find(expected.ID)
	if err != nil {
		return nil, err
	}
	return s.Workers.Get(expected.ID).Recover(expected, reason == "stalled", inst.Func)
}

func (s *Service) Logs(id string, after int64, limit int) (worker.LogChunk, error) {
	if err := s.Require(id); err != nil {
		return worker.LogChunk{}, err
	}
	return s.Workers.Get(id).LogSince(after, limit), nil
}

// Tasks of an instance, with the task the worker runs now as "running".
func (s *Service) Tasks(id string) (Tasks, error) {
	if err := s.Require(id); err != nil {
		return Tasks{}, err
	}
	out := Tasks{Running: []Task{}, Pending: []Task{}, Waiting: []Task{}}
	if s.Config == nil {
		return out, nil
	}
	var queue struct {
		Pending []Task `json:"pending"`
		Waiting []Task `json:"waiting"`
	}
	if err := s.Config.Call("tasks", map[string]any{"instance": id}, &queue); err != nil {
		return out, err
	}
	pending, waiting := append([]Task{}, queue.Pending...), append([]Task{}, queue.Waiting...)
	if current := s.Workers.Get(id).CurrentTask(); current != "" {
		running := Task{Command: current}
		for _, t := range append(append([]Task{}, pending...), waiting...) {
			if t.Command == current {
				running = t
				break
			}
		}
		out.Running = []Task{running}
		pending = without(pending, current)
		waiting = without(waiting, current)
	}
	out.Pending, out.Waiting = pending, waiting
	return out, nil
}

func without(tasks []Task, command string) []Task {
	out := []Task{}
	for _, t := range tasks {
		if t.Command != command {
			out = append(out, t)
		}
	}
	return out
}
