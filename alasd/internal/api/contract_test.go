package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

// dashboard/openapi.json is the contract of the API (docs/governance ADR 0002). These tests call
// every documented operation and validate the response body against its documented schema,
// strict in both directions: a missing, mistyped or undocumented field fails.

// openAPI is the part of an OpenAPI 3.0 document the contract test reads.
type openAPI struct {
	Paths      map[string]map[string]operation `json:"paths"`
	Components struct {
		Schemas map[string]any `json:"schemas"`
	} `json:"components"`
}

type operation struct {
	OperationID string `json:"operationId"`
	Responses   map[string]struct {
		Content map[string]struct {
			Schema map[string]any `json:"schema"`
		} `json:"content"`
	} `json:"responses"`
}

func loadContract(t *testing.T) openAPI {
	t.Helper()
	data, err := os.ReadFile("../../../dashboard/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc openAPI
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

// Keywords the validator implements. Anything else in the contract fails the test, so a new
// schema feature cannot be silently ignored.
var knownKeywords = map[string]bool{
	"$ref": true, "type": true, "properties": true, "required": true, "items": true, "enum": true,
	"anyOf": true, "allOf": true, "nullable": true, "additionalProperties": true,
	"minimum": true, "maximum": true, "minItems": true,
	"title": true, "description": true, "default": true,
}

type validator struct {
	schemas map[string]any
	errors  []string
}

func (v *validator) fail(path, format string, args ...any) {
	v.errors = append(v.errors, path+": "+fmt.Sprintf(format, args...))
}

func (v *validator) resolve(schema map[string]any) map[string]any {
	for {
		ref, ok := schema["$ref"].(string)
		if !ok {
			return schema
		}
		name := strings.TrimPrefix(ref, "#/components/schemas/")
		next, ok := v.schemas[name].(map[string]any)
		if !ok {
			panic("unknown $ref " + ref)
		}
		schema = next
	}
}

func (v *validator) check(schema map[string]any, value any, path string) {
	for key := range schema {
		if !knownKeywords[key] {
			panic(fmt.Sprintf("%s: the contract test does not implement %q", path, key))
		}
	}
	schema = v.resolve(schema)
	if value == nil {
		if schema["nullable"] != true {
			v.fail(path, "null is not allowed")
		}
		return
	}
	if all, ok := schema["allOf"].([]any); ok {
		for _, sub := range all {
			v.check(sub.(map[string]any), value, path)
		}
	}
	if any_, ok := schema["anyOf"].([]any); ok {
		matched := false
		for _, sub := range any_ {
			trial := &validator{schemas: v.schemas}
			trial.check(sub.(map[string]any), value, path)
			if len(trial.errors) == 0 {
				matched = true
				break
			}
		}
		if !matched {
			v.fail(path, "%v matches none of anyOf", value)
		}
	}
	if enum, ok := schema["enum"].([]any); ok {
		found := false
		for _, e := range enum {
			if e == value {
				found = true
			}
		}
		if !found {
			v.fail(path, "%v is not one of %v", value, enum)
		}
	}
	if number, ok := value.(float64); ok {
		if min, ok := schema["minimum"].(float64); ok && number < min {
			v.fail(path, "%v is below the minimum %v", number, min)
		}
		if max, ok := schema["maximum"].(float64); ok && number > max {
			v.fail(path, "%v is above the maximum %v", number, max)
		}
	}
	switch schema["type"] {
	case "string":
		if _, ok := value.(string); !ok {
			v.fail(path, "expected a string, got %T", value)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			v.fail(path, "expected a boolean, got %T", value)
		}
	case "number":
		if _, ok := value.(float64); !ok {
			v.fail(path, "expected a number, got %T", value)
		}
	case "integer":
		if n, ok := value.(float64); !ok || n != float64(int64(n)) {
			v.fail(path, "expected an integer, got %v", value)
		}
	case "array":
		list, ok := value.([]any)
		if !ok {
			v.fail(path, "expected an array, got %T", value)
			return
		}
		if items, ok := schema["items"].(map[string]any); ok {
			for i, item := range list {
				v.check(items, item, fmt.Sprintf("%s[%d]", path, i))
			}
		}
	case "object":
		obj, ok := value.(map[string]any)
		if !ok {
			v.fail(path, "expected an object, got %T", value)
			return
		}
		props, _ := schema["properties"].(map[string]any)
		required, _ := schema["required"].([]any)
		for _, name := range required {
			if _, ok := obj[name.(string)]; !ok {
				v.fail(path, "missing required field %q", name)
			}
		}
		for name, field := range obj {
			if prop, ok := props[name].(map[string]any); ok {
				v.check(prop, field, path+"."+name)
				continue
			}
			switch extra := schema["additionalProperties"].(type) {
			case map[string]any:
				v.check(extra, field, path+"."+name)
			case nil:
				// Strict: a field the server sends must be documented
				if props != nil {
					v.fail(path, "undocumented field %q", name)
				}
			case bool:
				if !extra {
					v.fail(path, "undocumented field %q", name)
				}
			}
		}
	}
}

func (v *validator) validate(t *testing.T, schema map[string]any, body []byte, what string) {
	t.Helper()
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Errorf("%s: not JSON: %v", what, err)
		return
	}
	v.errors = nil
	v.check(schema, value, what)
	for _, e := range v.errors {
		t.Error(e)
	}
}

// Request bodies of the operations that take one.
var requestBodies = map[string]string{
	"create_profile":  `{"id": "contract1", "source": "alas"}`,
	"config_update":   `{"revision": "r1", "changes": {"Alas.Emulator.Serial": "127.0.0.1:16384"}}`,
	"recovery_policy": `{"instances": {"alas": {"stallMinutes": 20}}}`,
}

// Order of the operations: start before the reads so the worker produces logs and a task.
var operationOrder = []string{"start", "list_instances", "get_instance", "logs", "tasks", "restart", "stop"}

func operationRank(id string) int {
	for i, name := range operationOrder {
		if name == id {
			return i
		}
	}
	return len(operationOrder)
}

func TestResponsesMatchContract(t *testing.T) {
	doc := loadContract(t)
	v := &validator{schemas: doc.Components.Schemas}
	e := newEnv(t, "")

	type call struct {
		method, path string
		op           operation
	}
	var calls []call
	for path, ops := range doc.Paths {
		for method, op := range ops {
			calls = append(calls, call{strings.ToUpper(method), path, op})
		}
	}
	sort.Slice(calls, func(i, j int) bool {
		ri, rj := operationRank(calls[i].op.OperationID), operationRank(calls[j].op.OperationID)
		if ri != rj {
			return ri < rj
		}
		return calls[i].op.OperationID < calls[j].op.OperationID
	})

	checked := 0
	for _, c := range calls {
		path := strings.ReplaceAll(c.path, "{instance_id}", "alas")
		for status, response := range c.op.Responses {
			content, ok := response.Content["application/json"]
			if !ok {
				continue // the event stream, checked by TestEventsMatchContract
			}
			req, _ := http.NewRequest(c.method, e.server.URL+path, strings.NewReader(requestBodies[c.op.OperationID]))
			if body := requestBodies[c.op.OperationID]; body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if fmt.Sprint(resp.StatusCode) != status {
				t.Errorf("%s %s: status %d, documented %s: %s", c.method, path, resp.StatusCode, status, body)
				continue
			}
			v.validate(t, content.Schema, body, c.op.OperationID)
			checked++
			if c.op.OperationID == "start" {
				// Let the fake worker log its task before the reads that follow
				time.Sleep(300 * time.Millisecond)
			}
		}
	}
	if checked < 15 {
		t.Fatalf("only %d operations checked", checked)
	}
}

// Server-sent events carry InstanceStatus and LogLine objects of the contract.
func TestEventsMatchContract(t *testing.T) {
	doc := loadContract(t)
	v := &validator{schemas: doc.Components.Schemas}
	e := newEnv(t, "")
	resp, err := http.Get(e.server.URL + "/api/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	e.do(t, "POST", "/api/v1/instances/alas/start", "")

	status := map[string]any{"$ref": "#/components/schemas/InstanceStatus"}
	logLine := map[string]any{"$ref": "#/components/schemas/LogLine"}
	seen := map[string]bool{}
	sc := bufio.NewScanner(resp.Body)
	deadline := time.Now().Add(5 * time.Second)
	kind := ""
	for sc.Scan() && time.Now().Before(deadline) && !(seen["instance.status.changed"] && seen["log.appended"]) {
		line := sc.Text()
		if strings.HasPrefix(line, "event: ") {
			kind = strings.TrimPrefix(line, "event: ")
			continue
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var payload map[string]json.RawMessage
		json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload)
		switch kind {
		case "instance.status.changed":
			v.validate(t, status, payload["data"], kind)
		case "log.appended":
			var lines []json.RawMessage
			json.Unmarshal(payload["lines"], &lines)
			for _, l := range lines {
				v.validate(t, logLine, l, kind)
			}
		}
		seen[kind] = true
	}
	if !seen["instance.status.changed"] || !seen["log.appended"] {
		t.Fatalf("events seen: %v", seen)
	}
}

// The validator itself: it must catch what it claims to catch.
func TestContractValidatorCatchesDrift(t *testing.T) {
	doc := loadContract(t)
	v := &validator{schemas: doc.Components.Schemas}
	line := map[string]any{"$ref": "#/components/schemas/LogLine"}
	cases := map[string]string{
		"missing field":     `{"seq": 1}`,
		"wrong type":        `{"seq": "1", "text": "x"}`,
		"not an integer":    `{"seq": 1.5, "text": "x"}`,
		"undocumented":      `{"seq": 1, "text": "x", "level": "INFO"}`,
		"null not nullable": `{"seq": null, "text": "x"}`,
	}
	for name, body := range cases {
		v.errors = nil
		var value any
		json.Unmarshal([]byte(body), &value)
		v.check(line, value, name)
		if len(v.errors) == 0 {
			t.Errorf("%s: accepted %s", name, body)
		}
	}
	v.errors = nil
	var ok any
	json.Unmarshal([]byte(`{"seq": 1, "text": "x"}`), &ok)
	v.check(line, ok, "valid")
	if len(v.errors) != 0 {
		t.Errorf("valid line rejected: %v", v.errors)
	}
}
