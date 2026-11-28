package sidecar

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Every method alasd calls exists on the Python sidecar (module/control/sidecar.py), and the
// sidecar has no public method that alasd does not call.
func TestCalledMethodsExistInPython(t *testing.T) {
	called := map[string]bool{}
	call := regexp.MustCompile(`\.Call\("([a-z_]+)"`)
	err := filepath.WalkDir("../..", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		data, err := os.ReadFile(path)
		for _, m := range call.FindAllStringSubmatch(string(data), -1) {
			called[m[1]] = true
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile("../../../module/control/sidecar.py")
	if err != nil {
		t.Fatal(err)
	}
	// Public methods of class Handlers: 4-space indented defs not starting with _
	defined := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^    def ([a-z][a-z_]*)\(`).FindAllStringSubmatch(string(src), -1) {
		defined[m[1]] = true
	}
	for name := range called {
		if !defined[name] {
			t.Errorf("alasd calls %q, sidecar.py has no such method", name)
		}
	}
	for name := range defined {
		if !called[name] {
			t.Errorf("sidecar.py method %q is never called by alasd: delete it or use it", name)
		}
	}
	if len(called) == 0 {
		t.Fatal("found no Call(...) in alasd")
	}
}
