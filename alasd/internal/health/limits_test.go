package health

import (
	"encoding/json"
	"os"
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
