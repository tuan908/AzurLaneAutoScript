package health

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The policy limits are stated in the contract (minimum/maximum); the Go validator uses the same.
func TestPolicyLimitsMatchContract(t *testing.T) {
	data, err := os.ReadFile("../../../dashboard/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Components struct {
			Schemas map[string]struct {
				Properties map[string]struct {
					Maximum *float64 `json:"maximum"`
					Items   *struct {
						Maximum *float64 `json:"maximum"`
					} `json:"items"`
				} `json:"properties"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	s := doc.Components.Schemas
	check := func(name string, got *float64, want int) {
		if got == nil || int(*got) != want {
			t.Errorf("%s: contract %v, Go %d", name, got, want)
		}
	}
	for _, schema := range []string{"RecoveryPolicy", "PolicyUpdate"} {
		check(schema+".maxRestartsPerHour", s[schema].Properties["maxRestartsPerHour"].Maximum, MaxRestartsPerHour)
		check(schema+".backoffSeconds[]", s[schema].Properties["backoffSeconds"].Items.Maximum, MaxBackoffSeconds)
	}
	for _, schema := range []string{"InstancePolicy", "PolicyOverride"} {
		check(schema+".stallMinutes", s[schema].Properties["stallMinutes"].Maximum, MaxStallMinutes)
	}
}

// A crashed worker counts as a human takeover when its log has the line the Python worker
// writes on RequestHumanTakeover.
func TestTakeoverMarkerMatchesWorker(t *testing.T) {
	src, err := os.ReadFile("../../../module/control/worker.py")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, marker := range humanTakeoverMarkers {
		if strings.Contains(string(src), `logger.critical("`+marker+`")`) {
			found = true
		}
	}
	if !found {
		t.Errorf("module/control/worker.py logs none of %q on RequestHumanTakeover", humanTakeoverMarkers)
	}
}
