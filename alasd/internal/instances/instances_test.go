package instances

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Same cases as tests/control/test_instance_listing.py, which checks the Python rule
// (module.config.utils.alas_instance) this listing mirrors.
func TestListMatchesPythonRule(t *testing.T) {
	data, err := os.ReadFile("../../../tests/control/fixtures/instance_listing.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name      string     `json:"name"`
			Files     []string   `json:"files"`
			Instances []Instance `json:"instances"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			root := t.TempDir()
			os.MkdirAll(filepath.Join(root, "config"), 0o755)
			for _, name := range c.Files {
				os.WriteFile(filepath.Join(root, "config", name), []byte("{}"), 0o644)
			}
			got := (&Service{Root: root}).List()
			if !reflect.DeepEqual(got, c.Instances) {
				t.Errorf("got %v, want %v", got, c.Instances)
			}
		})
	}
}
