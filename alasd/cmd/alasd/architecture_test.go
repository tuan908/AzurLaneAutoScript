package main

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Allowed imports between the packages of alasd (doc/governance ADR 0003). The direction is
// low → high: proc, timeutil → worker → sidecar → instances → health → api → cmd/alasd.
// A new edge needs a reason and an entry here.
var allowed = map[string][]string{
	"proc":      {},
	"timeutil":  {},
	"worker":    {"proc", "timeutil"},
	"sidecar":   {"proc"},
	"instances": {"sidecar", "worker"},
	"health":    {"instances", "timeutil", "worker"},
	"api":       {"health", "instances", "sidecar", "timeutil"},
}

func TestPackageDependencies(t *testing.T) {
	dirs, err := os.ReadDir("../../internal")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, dir := range dirs {
		if !dir.IsDir() {
			continue
		}
		pkg := dir.Name()
		seen[pkg] = true
		rules, ok := allowed[pkg]
		if !ok {
			t.Errorf("internal/%s is not in the dependency rules of architecture_test.go", pkg)
			continue
		}
		files, _ := filepath.Glob(filepath.Join("../../internal", pkg, "*.go"))
		for _, file := range files {
			if strings.HasSuffix(file, "_test.go") {
				continue
			}
			f, err := parser.ParseFile(token.NewFileSet(), file, nil, parser.ImportsOnly)
			if err != nil {
				t.Fatal(err)
			}
			for _, imp := range f.Imports {
				path, _ := strconv.Unquote(imp.Path.Value)
				target, ok := strings.CutPrefix(path, "alasd/internal/")
				if !ok {
					continue
				}
				if !contains(rules, target) {
					t.Errorf("%s imports internal/%s, allowed: %v", file, target, rules)
				}
			}
		}
	}
	var stale []string
	for pkg := range allowed {
		if !seen[pkg] {
			stale = append(stale, pkg)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("rules for packages that no longer exist: %v", stale)
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
