package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"alasd/internal/health"
	"alasd/internal/instances"
	"alasd/internal/sidecar"
	"alasd/internal/worker"
)

// The test binary is also a fake worker (FAKE_WORKER) and a fake config sidecar (FAKE_SIDECAR).
func TestMain(m *testing.M) {
	switch {
	case os.Getenv("FAKE_WORKER") == "1":
		fmt.Println(`{"log": "Scheduler: Start task ` + "`Commission`" + `"}`)
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			if sc.Text() == "stop" {
				os.Exit(0)
			}
		}
		os.Exit(0)
	case os.Getenv("FAKE_SIDECAR") == "1":
		fakeSidecar()
		return
	}
	os.Exit(m.Run())
}

func fakeSidecar() {
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var req struct {
			ID     int64          `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		json.Unmarshal(sc.Bytes(), &req)
		resp := map[string]any{"id": req.ID}
		switch req.Method {
		case "read":
			resp["result"] = map[string]any{"revision": "r1", "config": map[string]any{}}
		case "update":
			switch req.Params["revision"] {
			case "r1":
				resp["result"] = map[string]any{"revision": "r2", "applied": req.Params["changes"]}
			case "bad":
				resp["error"] = map[string]any{"type": "ConfigInvalid", "message": "", "errors": map[string]string{"A.B.C": "Unknown setting"}}
			case "busy":
				resp["error"] = map[string]any{"type": "ConfigLockTimeout", "message": "busy"}
			default:
				resp["error"] = map[string]any{"type": "ConfigConflict", "message": "r1", "revision": "r1"}
			}
		case "tasks":
			resp["result"] = map[string]any{
				"pending": []any{map[string]any{"command": "Commission", "nextRun": "2020-01-01 00:00:00"},
					map[string]any{"command": "Reward", "nextRun": "2020-01-01 00:00:00"}},
				"waiting": []any{}}
		case "schema":
			resp["result"] = map[string]any{"lang": req.Params["lang"], "menus": []any{}}
		case "create":
			os.WriteFile(filepath.Join("config", req.Params["instance"].(string)+".json"), []byte("{}"), 0o644)
			resp["result"] = nil
		default:
			resp["error"] = map[string]any{"type": "ValueError", "message": "Unknown method"}
		}
		b, _ := json.Marshal(resp)
		fmt.Println(string(b))
	}
}

type env struct {
	root   string
	api    *API
	server *httptest.Server
}

func newEnv(t *testing.T, password string) *env {
	t.Helper()
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "config"), 0o755)
	for _, name := range []string{"alas.json", "alas2.json", "template.json", "maa1.maa.json"} {
		os.WriteFile(filepath.Join(root, "config", name), []byte("{}"), 0o644)
	}
	os.MkdirAll(filepath.Join(root, "dashboard", "dist", "assets"), 0o755)
	os.WriteFile(filepath.Join(root, "dashboard", "dist", "index.html"), []byte("<html>dashboard</html>"), 0o644)
	os.WriteFile(filepath.Join(root, "dashboard", "dist", "assets", "app.js"), []byte("1"), 0o644)
	openapi, _ := os.ReadFile("../../../dashboard/openapi.json")
	os.WriteFile(filepath.Join(root, "dashboard", "openapi.json"), openapi, 0o644)

	exe, _ := os.Executable()
	t.Setenv("FAKE_WORKER", "")
	registry := worker.NewRegistry(worker.Config{
		Root: root, GracefulStop: time.Second, DrainTimeout: 500 * time.Millisecond,
		Command: func(id, fn string) []string {
			return []string{"env", "FAKE_WORKER=1", exe}
		},
	})
	config := &sidecar.Client{Root: root, Command: []string{"env", "FAKE_SIDECAR=1", exe}}
	t.Cleanup(config.Close)
	service := &instances.Service{Root: root, Workers: registry, Config: config}
	monitor := health.NewMonitor(service, health.NewPolicyStore(root))
	service.Health = monitor.InstanceHealth
	a := New(&API{Root: root, Service: service, Config: config, Monitor: monitor, Password: password})
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(func() {
		srv.Close()
		for _, m := range registry.All() {
			m.Stop()
		}
	})
	return &env{root: root, api: a, server: srv}
}

func (e *env) do(t *testing.T, method, path string, body string, headers ...string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, e.server.URL+path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		if headers[i] == "Host" {
			req.Host = headers[i+1]
		} else {
			req.Header.Set(headers[i], headers[i+1])
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var out map[string]any
	json.Unmarshal(data, &out)
	return resp.StatusCode, out
}

func errCode(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

func TestInstancesAndLifecycle(t *testing.T) {
	e := newEnv(t, "")
	code, body := e.do(t, "GET", "/api/v1/instances", "")
	var ids []string
	for _, s := range body["instances"].([]any) {
		ids = append(ids, s.(map[string]any)["id"].(string))
	}
	if code != 200 || strings.Join(ids, ",") != "alas,alas2,maa1" {
		t.Fatalf("instances %d %v", code, ids)
	}
	if code, body := e.do(t, "GET", "/api/v1/instances/nope", ""); code != 404 || errCode(body) != "unknown_instance" {
		t.Fatalf("unknown %d %v", code, body)
	}
	if code, _ := e.do(t, "GET", "/api/v1/instances/alas/start", ""); code != 405 {
		t.Fatalf("GET on a command: %d", code)
	}
	code, body = e.do(t, "POST", "/api/v1/instances/alas/start", "")
	if code != 200 || body["state"] != "running" || body["processId"] == nil {
		t.Fatalf("start %d %v", code, body)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, body = e.do(t, "GET", "/api/v1/instances/alas/tasks", "")
		if running := body["running"].([]any); len(running) == 1 {
			if running[0].(map[string]any)["command"] != "Commission" || len(body["pending"].([]any)) != 1 {
				t.Fatalf("tasks %v", body)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no running task: %v", body)
		}
		time.Sleep(20 * time.Millisecond)
	}
	code, body = e.do(t, "POST", "/api/v1/instances/alas/stop", "")
	if code != 200 || body["state"] != "stopped" {
		t.Fatalf("stop %d %v", code, body)
	}
	_, body = e.do(t, "GET", "/api/v1/instances/alas/logs?after=0&limit=1", "")
	lines := body["lines"].([]any)
	if len(lines) != 1 || lines[0].(map[string]any)["text"] != "[alas] exited. Reason: Manual stop" {
		t.Fatalf("logs %v", body)
	}
	if code, _ := e.do(t, "GET", "/api/v1/instances/alas/logs?after=x", ""); code != 400 {
		t.Fatalf("bad after: %d", code)
	}
}

func TestAccess(t *testing.T) {
	e := newEnv(t, "")
	if code, body := e.do(t, "GET", "/api/v1/health", "", "Host", "alas.example.com"); code != 403 || errCode(body) != "loopback_only" {
		t.Fatalf("dns rebinding %d %v", code, body)
	}
	if code, _ := e.do(t, "GET", "/api/v1/health", "", "Host", "localhost:22267"); code != 200 {
		t.Fatalf("localhost name: %d", code)
	}
	if code, body := e.do(t, "POST", "/api/v1/instances/alas/stop", "", "Origin", "http://evil.example"); code != 403 || errCode(body) != "cross_origin" {
		t.Fatalf("cross site %d %v", code, body)
	}
	if code, _ := e.do(t, "POST", "/api/v1/instances/alas/stop", "", "Origin", e.server.URL); code != 200 {
		t.Fatalf("same origin: %d", code)
	}

	p := newEnv(t, "secret")
	if code, body := p.do(t, "GET", "/api/v1/health", ""); code != 401 || errCode(body) != "unauthorized" {
		t.Fatalf("no token %d", code)
	}
	if code, _ := p.do(t, "GET", "/api/v1/health", "", "Authorization", "Bearer wrong"); code != 401 {
		t.Fatalf("wrong token %d", code)
	}
	if code, _ := p.do(t, "GET", "/api/v1/health", "", "Authorization", "Bearer secret", "Host", "alas.example.com"); code != 200 {
		t.Fatalf("token from a remote host %d", code)
	}
}

func TestConfigEndpoints(t *testing.T) {
	e := newEnv(t, "")
	if code, body := e.do(t, "GET", "/api/v1/instances/alas/config", ""); code != 200 || body["revision"] != "r1" {
		t.Fatalf("read %d %v", code, body)
	}
	if code, body := e.do(t, "GET", "/api/v1/config/schema?lang=zh-CN", ""); code != 200 || body["lang"] != "zh-CN" {
		t.Fatalf("schema %d %v", code, body)
	}
	if code, _ := e.do(t, "GET", "/api/v1/config/schema?lang=xx", ""); code != 400 {
		t.Fatalf("bad lang %d", code)
	}
	patch := func(rev string) (int, map[string]any) {
		return e.do(t, "PATCH", "/api/v1/instances/alas/config", `{"revision": "`+rev+`", "changes": {"A.B.C": 1}}`)
	}
	if code, body := patch("r1"); code != 200 || body["revision"] != "r2" {
		t.Fatalf("update %d %v", code, body)
	}
	if code, body := patch("old"); code != 409 || errCode(body) != "conflict" || body["revision"] != "r1" {
		t.Fatalf("conflict %d %v", code, body)
	}
	if code, body := patch("bad"); code != 400 || errCode(body) != "invalid" || body["fields"] == nil {
		t.Fatalf("invalid %d %v", code, body)
	}
	if code, body := patch("busy"); code != 503 || errCode(body) != "config_busy" {
		t.Fatalf("busy %d %v", code, body)
	}
	req, _ := http.NewRequest("PATCH", e.server.URL+"/api/v1/instances/alas/config", strings.NewReader("{}"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 415 {
		t.Fatalf("no content type: %d", resp.StatusCode)
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/instances/alas/config", `{"changes": {}}`); code != 400 {
		t.Fatalf("no revision: %d", code)
	}
	if code, body := e.do(t, "POST", "/api/v1/instances", `{"id": "ALAS2"}`); code != 409 || errCode(body) != "profile_exists" {
		t.Fatalf("duplicate profile %d %v", code, body)
	}
	if code, body := e.do(t, "POST", "/api/v1/instances", `{"id": "new1", "source": "alas"}`); code != 201 || body["id"] != "new1" {
		t.Fatalf("create %d %v", code, body)
	}
}

func TestRecoveryEndpoints(t *testing.T) {
	e := newEnv(t, "")
	if code, body := e.do(t, "GET", "/api/v1/recovery", ""); code != 200 || body["policy"] == nil {
		t.Fatalf("recovery %d %v", code, body)
	}
	code, body := e.do(t, "PATCH", "/api/v1/recovery/policy", `{"maxRestartsPerHour": 5}`)
	if code != 200 || body["policy"].(map[string]any)["maxRestartsPerHour"] != 5.0 {
		t.Fatalf("policy %d %v", code, body)
	}
	if code, body := e.do(t, "PATCH", "/api/v1/recovery/policy", `{"maxRestartsPerHour": 500}`); code != 400 || errCode(body) != "bad_request" {
		t.Fatalf("invalid policy %d %v", code, body)
	}
}

func TestHealthDetails(t *testing.T) {
	e := newEnv(t, "")
	code, body := e.do(t, "GET", "/api/v1/health/details", "")
	if code != 200 || body["apiVersion"] != 1.0 || body["metrics"] == nil || len(body["instanceDetails"].([]any)) != 3 {
		t.Fatalf("details %d %v", code, body)
	}
}

func TestEventsStream(t *testing.T) {
	e := newEnv(t, "")
	resp, err := http.Get(e.server.URL + "/api/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("content type %s", resp.Header.Get("Content-Type"))
	}
	events := make(chan string, 100)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			if strings.HasPrefix(sc.Text(), "event: ") {
				events <- strings.TrimPrefix(sc.Text(), "event: ")
			}
		}
		close(events)
	}()
	want := func(kind string) {
		t.Helper()
		timeout := time.After(5 * time.Second)
		for {
			select {
			case ev := <-events:
				if ev == kind {
					return
				}
			case <-timeout:
				t.Fatalf("no %s event", kind)
			}
		}
	}
	want("resync")
	want("instance.status.changed")
	e.do(t, "POST", "/api/v1/instances/alas/start", "")
	want("log.appended")
	if code, body := e.do(t, "GET", "/api/v1/events", "", "Origin", "http://evil.example"); code != 403 || errCode(body) != "cross_origin" {
		t.Fatalf("cross-site events %d", code)
	}
}

func TestDashboard(t *testing.T) {
	e := newEnv(t, "")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(e.server.URL + "/dashboard")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 307 {
		t.Fatalf("redirect %d", resp.StatusCode)
	}
	get := func(path, accept string) (int, string, http.Header) {
		req, _ := http.NewRequest("GET", e.server.URL+path, nil)
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), resp.Header
	}
	if code, body, h := get("/dashboard/", ""); code != 200 || body != "<html>dashboard</html>" || h.Get("Cache-Control") != "no-cache" {
		t.Fatalf("index %d %q %v", code, body, h)
	}
	if code, body, _ := get("/dashboard/alas", "text/html"); code != 200 || body != "<html>dashboard</html>" {
		t.Fatalf("client route %d", code)
	}
	if code, _, _ := get("/dashboard/assets/missing.js", "text/html"); code != 404 {
		t.Fatalf("missing asset %d", code)
	}
	if _, _, h := get("/dashboard/assets/app.js", ""); !strings.HasPrefix(h.Get("Content-Type"), "text/javascript") {
		t.Fatalf("js type %s", h.Get("Content-Type"))
	}
	if code, _, _ := get("/dashboard/../config/alas.json", ""); code == 200 {
		t.Fatal("path traversal")
	}
}

// Every operation of dashboard/openapi.json has a route, and every route is in openapi.json.
func TestRoutesMatchOpenAPI(t *testing.T) {
	data, err := os.ReadFile("../../../dashboard/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Paths map[string]map[string]any `json:"paths"`
	}
	json.Unmarshal(data, &doc)
	var documented []string
	for path, ops := range doc.Paths {
		for method := range ops {
			documented = append(documented, strings.ToUpper(method)+" "+path)
		}
	}
	src, _ := os.ReadFile("api.go")
	re := regexp.MustCompile(`HandleFunc\("(GET|POST|PATCH) "\+Prefix\+"([^"]+)"`)
	var routed []string
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		if m[2] == "/openapi.json" {
			continue
		}
		routed = append(routed, m[1]+" "+Prefix+strings.ReplaceAll(m[2], "{id}", "{instance_id}"))
	}
	sort.Strings(documented)
	sort.Strings(routed)
	if strings.Join(documented, "\n") != strings.Join(routed, "\n") {
		t.Fatalf("openapi.json:\n%s\n\nroutes:\n%s", strings.Join(documented, "\n"), strings.Join(routed, "\n"))
	}
}
