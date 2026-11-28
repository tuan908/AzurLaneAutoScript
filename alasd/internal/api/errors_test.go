package api

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// mapError turns sidecar errors into HTTP statuses by the Python exception class name. Each name
// it handles must be a class of the Python code (or a builtin), or a rename there would turn a
// 409/400/503 into a 500 without any test noticing.
func TestMappedErrorTypesExistInPython(t *testing.T) {
	src, err := os.ReadFile("api.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	start := strings.Index(body, "func mapError(")
	end := strings.Index(body[start:], "\n}\n")
	handled := regexp.MustCompile(`case "([A-Za-z]+)":`).FindAllStringSubmatch(body[start:start+end], -1)
	if len(handled) < 5 {
		t.Fatalf("found only %d handled error types in mapError", len(handled))
	}
	classes := map[string]bool{"ValueError": true}
	class := regexp.MustCompile(`(?m)^class ([A-Za-z]+)\(`)
	for _, dir := range []string{"../../../module/control", "../../../module/config"} {
		filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || !strings.HasSuffix(path, ".py") {
				return err
			}
			data, err := os.ReadFile(path)
			for _, m := range class.FindAllStringSubmatch(string(data), -1) {
				classes[m[1]] = true
			}
			return err
		})
	}
	for _, m := range handled {
		if !classes[m[1]] {
			t.Errorf("mapError handles %q, no such Python exception class", m[1])
		}
	}
}
