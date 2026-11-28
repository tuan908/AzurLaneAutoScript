package health

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"gopkg.in/yaml.v3"
)

// PolicyFile relative to the ALAS root.
const PolicyFile = "config/control.yaml"

// InstancePolicy of one instance. Pointers in overrides: only the keys that were set.
type InstancePolicy struct {
	AutoRestart    bool `json:"autoRestart" yaml:"autoRestart"`
	RestartOnStall bool `json:"restartOnStall" yaml:"restartOnStall"`
	StallMinutes   int  `json:"stallMinutes" yaml:"stallMinutes"`
}

// Override of an instance policy, the keys that were set.
type Override struct {
	AutoRestart    *bool `json:"autoRestart,omitempty" yaml:"autoRestart,omitempty"`
	RestartOnStall *bool `json:"restartOnStall,omitempty" yaml:"restartOnStall,omitempty"`
	StallMinutes   *int  `json:"stallMinutes,omitempty" yaml:"stallMinutes,omitempty"`
}

// Policy of recovery, persisted in config/control.yaml.
type Policy struct {
	MaxRestartsPerHour int                 `json:"maxRestartsPerHour" yaml:"maxRestartsPerHour"`
	BackoffSeconds     []int               `json:"backoffSeconds" yaml:"backoffSeconds"`
	Instances          map[string]Override `json:"instances" yaml:"instances"`
}

func DefaultPolicy() Policy {
	return Policy{MaxRestartsPerHour: 3, BackoffSeconds: []int{30, 120, 300}, Instances: map[string]Override{}}
}

// Policy limits. dashboard/openapi.json states them as minimum/maximum; policy_test.go compares.
const (
	MaxRestartsPerHour = 60
	MaxStallMinutes    = 1440
	MaxBackoffSeconds  = 86400
)

var defaultInstance = InstancePolicy{AutoRestart: true, RestartOnStall: false, StallMinutes: 30}

func (p Policy) clone() Policy {
	out := Policy{MaxRestartsPerHour: p.MaxRestartsPerHour, BackoffSeconds: append([]int{}, p.BackoffSeconds...),
		Instances: map[string]Override{}}
	for k, v := range p.Instances {
		out.Instances[k] = v
	}
	return out
}

type PolicyStore struct {
	Path   string
	mu     sync.Mutex
	policy *Policy
}

func NewPolicyStore(root string) *PolicyStore {
	return &PolicyStore{Path: filepath.Join(root, PolicyFile)}
}

func (s *PolicyStore) load() Policy {
	policy := DefaultPolicy()
	data, err := os.ReadFile(s.Path)
	if err != nil {
		return policy
	}
	var file struct {
		MaxRestartsPerHour *int                `yaml:"maxRestartsPerHour"`
		BackoffSeconds     []int               `yaml:"backoffSeconds"`
		Instances          map[string]Override `yaml:"instances"`
	}
	if err := yaml.Unmarshal(data, &file); err != nil {
		log.Printf("Cannot read %s: %v, using the default recovery policy", s.Path, err)
		return policy
	}
	if file.MaxRestartsPerHour != nil {
		policy.MaxRestartsPerHour = *file.MaxRestartsPerHour
	}
	if file.BackoffSeconds != nil {
		policy.BackoffSeconds = file.BackoffSeconds
	}
	if file.Instances != nil {
		policy.Instances = file.Instances
	}
	return policy
}

// Get the policy (a copy).
func (s *PolicyStore) Get() Policy {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.policy == nil {
		p := s.load()
		s.policy = &p
	}
	return s.policy.clone()
}

// Instance policy merged over the defaults.
func (s *PolicyStore) Instance(id string) InstancePolicy {
	merged := defaultInstance
	o := s.Get().Instances[id]
	if o.AutoRestart != nil {
		merged.AutoRestart = *o.AutoRestart
	}
	if o.RestartOnStall != nil {
		merged.RestartOnStall = *o.RestartOnStall
	}
	if o.StallMinutes != nil {
		merged.StallMinutes = *o.StallMinutes
	}
	return merged
}

// ValidationError: invalid policy change, nothing was changed.
type ValidationError string

func (e ValidationError) Error() string { return string(e) }

func asInt(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != float64(int(f)) {
		return 0, false
	}
	return int(f), true
}

// Update applies changes decoded from JSON: {"maxRestartsPerHour": n, "backoffSeconds": [n],
// "instances": {id: {...}}}; instance entries are merged key by key.
func (s *PolicyStore) Update(changes any) (Policy, error) {
	obj, ok := changes.(map[string]any)
	if !ok {
		return Policy{}, ValidationError("Policy must be an object")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var current Policy
	if s.policy != nil {
		current = *s.policy
	} else {
		current = s.load()
	}
	next := current.clone()
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := obj[key]
		switch key {
		case "maxRestartsPerHour":
			n, ok := asInt(value)
			if !ok || n < 0 || n > MaxRestartsPerHour {
				return Policy{}, ValidationError(fmt.Sprintf("maxRestartsPerHour must be an integer from 0 to %d", MaxRestartsPerHour))
			}
			next.MaxRestartsPerHour = n
		case "backoffSeconds":
			list, ok := value.([]any)
			if !ok || len(list) == 0 {
				return Policy{}, ValidationError("backoffSeconds must be a list of seconds")
			}
			var secs []int
			for _, item := range list {
				n, ok := asInt(item)
				if !ok || n < 0 || n > MaxBackoffSeconds {
					return Policy{}, ValidationError("backoffSeconds must be a list of seconds")
				}
				secs = append(secs, n)
			}
			next.BackoffSeconds = secs
		case "instances":
			entries, ok := value.(map[string]any)
			if !ok {
				return Policy{}, ValidationError("instances must be an object")
			}
			for iid, raw := range entries {
				entry, ok := raw.(map[string]any)
				if !ok {
					return Policy{}, ValidationError(fmt.Sprintf("instances.%s must be an object", iid))
				}
				merged := next.Instances[iid]
				for k, v := range entry {
					switch k {
					case "autoRestart", "restartOnStall":
						b, ok := v.(bool)
						if !ok {
							return Policy{}, ValidationError(fmt.Sprintf("instances.%s.%s must be true or false", iid, k))
						}
						if k == "autoRestart" {
							merged.AutoRestart = &b
						} else {
							merged.RestartOnStall = &b
						}
					case "stallMinutes":
						n, ok := asInt(v)
						if _, isBool := v.(bool); isBool || !ok || n < 0 || n > MaxStallMinutes {
							return Policy{}, ValidationError(fmt.Sprintf("instances.%s.stallMinutes must be 0 to %d", iid, MaxStallMinutes))
						}
						merged.StallMinutes = &n
					default:
						return Policy{}, ValidationError(fmt.Sprintf("Unknown setting instances.%s.%s", iid, k))
					}
				}
				next.Instances[iid] = merged
			}
		default:
			return Policy{}, ValidationError(fmt.Sprintf("Unknown setting %s", key))
		}
	}
	if err := s.write(next); err != nil {
		return Policy{}, err
	}
	s.policy = &next
	return next.clone(), nil
}

func (s *PolicyStore) write(p Policy) error {
	data, err := yaml.Marshal(p)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o755); err != nil {
		return err
	}
	tmp := s.Path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.Path)
}
