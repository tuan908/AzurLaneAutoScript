// Package api is the HTTP API of the control server at /api/v1 (contract: dashboard/openapi.json),
// and the built dashboard at /dashboard.
//
// Access:
//   - With a password, every request needs `Authorization: Bearer <password>`.
//   - Without one, only loopback clients with a loopback Host header (blocks DNS rebinding).
//   - Requests with an Origin of another site are refused (blocks cross-site POSTs).
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"alasd/internal/health"
	"alasd/internal/instances"
	"alasd/internal/sidecar"
	"alasd/internal/timeutil"
)

const (
	Prefix     = "/api/v1"
	Version    = 1
	Dashboard  = "/dashboard"
	maxBodyLen = 4 << 20
)

type API struct {
	Root     string
	Service  *instances.Service
	Config   *sidecar.Client // nil disables config endpoints
	Monitor  *health.Monitor // nil disables recovery endpoints
	Password string
	// ShuttingDown ends the event streams
	ShuttingDown func() bool

	startedAt        time.Time
	streamID         string
	eventConnections atomic.Int64
}

func New(a *API) *API {
	a.startedAt = time.Now()
	a.streamID = fmt.Sprintf("%x", time.Now().UnixNano())
	if a.ShuttingDown == nil {
		a.ShuttingDown = func() bool { return false }
	}
	return a
}

// ------------------------------------------------------------ responses

type apiError struct {
	status int
	body   map[string]any
}

func (e *apiError) Error() string { return fmt.Sprint(e.body) }

func errBody(status int, code, message string) *apiError {
	return &apiError{status, map[string]any{"error": map[string]any{"code": code, "message": message}}}
}

func badRequest(message string) *apiError { return errBody(400, "bad_request", message) }

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(body)
}

// mapError turns service errors into API errors, like ControlApi._map_error.
func mapError(err error) *apiError {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae
	}
	var unknown instances.UnknownInstance
	if errors.As(err, &unknown) {
		return errBody(404, "unknown_instance", fmt.Sprintf("No instance named '%s'", unknown.ID))
	}
	var ve health.ValidationError
	if errors.As(err, &ve) {
		return badRequest(string(ve))
	}
	var se *sidecar.Error
	if errors.As(err, &se) {
		switch se.Type {
		case "ConfigConflict":
			return &apiError{409, map[string]any{
				"error":    map[string]any{"code": "conflict", "message": "The config changed since it was read; reload it"},
				"revision": se.Revision}}
		case "ConfigInvalid":
			return &apiError{400, map[string]any{
				"error":  map[string]any{"code": "invalid", "message": "Some values are invalid; nothing was saved"},
				"fields": se.Errors}}
		case "ConfigUnsupported":
			return errBody(501, "unsupported", se.Message)
		case "ProfileExists":
			return errBody(409, "profile_exists", "A profile with that name already exists")
		case "ConfigLockTimeout":
			return errBody(503, "config_busy", "The config is being saved by Alas or the GUI; try again")
		case "ValueError":
			return badRequest(se.Message)
		}
		return errBody(500, "internal", se.Error())
	}
	if errors.Is(err, sidecar.ErrUnavailable) {
		return errBody(503, "config_unavailable", err.Error())
	}
	return errBody(500, "internal", err.Error())
}

// ------------------------------------------------------------ access

func isLoopback(host string) bool {
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func hostName(hostport string) string {
	u, err := url.Parse("//" + hostport)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func portOrDefault(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

func sameOrigin(r *http.Request, origin string) bool {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	expected, err1 := url.Parse(scheme + "://" + r.Host)
	supplied, err2 := url.Parse(origin)
	if err1 != nil || err2 != nil {
		return false
	}
	return supplied.Scheme == expected.Scheme && strings.EqualFold(supplied.Hostname(), expected.Hostname()) &&
		portOrDefault(supplied) == portOrDefault(expected)
}

func (a *API) refuse(r *http.Request) *apiError {
	if origin := r.Header.Get("Origin"); origin != "" && !sameOrigin(r, origin) {
		return errBody(403, "cross_origin", "Cross-site requests are not allowed")
	}
	if a.Password != "" {
		scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		if !strings.EqualFold(scheme, "bearer") || subtle.ConstantTimeCompare([]byte(token), []byte(a.Password)) != 1 {
			return errBody(401, "unauthorized", "Send Authorization: Bearer <password>")
		}
		return nil
	}
	client, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		client = r.RemoteAddr
	}
	if !isLoopback(client) || !isLoopback(hostName(r.Host)) {
		return errBody(403, "loopback_only", "Without a password the API only accepts local requests")
	}
	return nil
}

type handler func(w http.ResponseWriter, r *http.Request) (status int, body any, err error)

func (a *API) guard(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if e := a.refuse(r); e != nil {
			writeJSON(w, e.status, e.body)
			return
		}
		status, body, err := h(w, r)
		if err != nil {
			e := mapError(err)
			writeJSON(w, e.status, e.body)
			return
		}
		if body != nil {
			writeJSON(w, status, body)
		}
	}
}

func readJSON(r *http.Request) (any, error) {
	mediatype, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediatype != "application/json" {
		return nil, errBody(415, "unsupported_media_type", "Send Content-Type: application/json")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBodyLen))
	if err != nil {
		return nil, badRequest("Body is not valid JSON")
	}
	var body any
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, badRequest("Body is not valid JSON")
	}
	return body, nil
}

// ------------------------------------------------------------ routes

// Handler with the API, the dashboard, and a redirect from / to the dashboard.
func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	g := a.guard
	mux.HandleFunc("GET "+Prefix+"/openapi.json", g(a.openapi))
	mux.HandleFunc("GET "+Prefix+"/health", g(a.health))
	mux.HandleFunc("GET "+Prefix+"/health/details", g(a.healthDetails))
	mux.HandleFunc("GET "+Prefix+"/instances", g(a.listInstances))
	mux.HandleFunc("GET "+Prefix+"/instances/{id}", g(a.getInstance))
	mux.HandleFunc("POST "+Prefix+"/instances/{id}/start", g(a.start))
	mux.HandleFunc("POST "+Prefix+"/instances/{id}/stop", g(a.stop))
	mux.HandleFunc("POST "+Prefix+"/instances/{id}/restart", g(a.restart))
	mux.HandleFunc("GET "+Prefix+"/instances/{id}/logs", g(a.logs))
	mux.HandleFunc("GET "+Prefix+"/instances/{id}/tasks", g(a.tasks))
	mux.HandleFunc("GET "+Prefix+"/events", a.events)
	if a.Config != nil {
		mux.HandleFunc("POST "+Prefix+"/instances", g(a.createProfile))
		mux.HandleFunc("GET "+Prefix+"/config/schema", g(a.configSchema))
		mux.HandleFunc("GET "+Prefix+"/instances/{id}/config/schema", g(a.configSchema))
		mux.HandleFunc("GET "+Prefix+"/instances/{id}/config", g(a.configRead))
		mux.HandleFunc("PATCH "+Prefix+"/instances/{id}/config", g(a.configUpdate))
	}
	if a.Monitor != nil {
		mux.HandleFunc("GET "+Prefix+"/recovery", g(a.recovery))
		mux.HandleFunc("PATCH "+Prefix+"/recovery/policy", g(a.recoveryPolicy))
	}
	dist := filepath.Join(a.Root, "dashboard", "dist")
	if st, err := os.Stat(dist); err == nil && st.IsDir() {
		mux.HandleFunc("GET "+Dashboard, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, Dashboard+"/", http.StatusTemporaryRedirect)
		})
		mux.Handle("GET "+Dashboard+"/", http.StripPrefix(Dashboard, dashboardFiles{dir: dist}))
		mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, Dashboard+"/", http.StatusTemporaryRedirect)
		})
	}
	return mux
}

// ------------------------------------------------------------ endpoints

func (a *API) openapi(w http.ResponseWriter, r *http.Request) (int, any, error) {
	data, err := os.ReadFile(filepath.Join(a.Root, "dashboard", "openapi.json"))
	if err != nil {
		return 0, nil, errBody(404, "not_found", "dashboard/openapi.json is missing")
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
	return 0, nil, nil
}

func (a *API) health(w http.ResponseWriter, r *http.Request) (int, any, error) {
	return 200, a.healthBody(false), nil
}

func (a *API) healthDetails(w http.ResponseWriter, r *http.Request) (int, any, error) {
	return 200, a.healthBody(true), nil
}

func (a *API) healthBody(detailed bool) map[string]any {
	now := time.Now()
	statuses := a.Service.Statuses()
	running, failed, successes, failures := 0, 0, 0, 0
	for _, s := range statuses {
		switch s.State {
		case "starting", "running", "stopping":
			running++
		case "failed":
			failed++
		}
		successes += s.TaskSuccesses
		failures += s.TaskFailures
	}
	body := map[string]any{
		"status":        "ok",
		"apiVersion":    Version,
		"time":          timeutil.ISO(now),
		"serverPid":     os.Getpid(),
		"uptimeSeconds": float64(now.Sub(a.startedAt).Milliseconds()) / 1000,
		"instances":     map[string]int{"total": len(statuses), "running": running, "failed": failed},
		// No SyncManager any more; kept true for clients that read it
		"logQueueManagerAlive": true,
	}
	if a.Monitor != nil {
		body["health"] = a.Monitor.Checks()
	}
	if detailed {
		restarts := 0
		if a.Monitor != nil {
			restarts = a.Monitor.RestartCount
		}
		body["metrics"] = map[string]any{
			"taskSuccesses":  successes,
			"taskFailures":   failures,
			"workerRestarts": restarts,
			"sseConnections": a.eventConnections.Load(),
		}
		body["instanceDetails"] = statuses
	}
	return body
}

func (a *API) recovery(w http.ResponseWriter, r *http.Request) (int, any, error) {
	return 200, a.Monitor.Snapshot(), nil
}

func (a *API) recoveryPolicy(w http.ResponseWriter, r *http.Request) (int, any, error) {
	body, err := readJSON(r)
	if err != nil {
		return 0, nil, err
	}
	policy, err := a.Monitor.Policy.Update(body)
	if err != nil {
		return 0, nil, err
	}
	return 200, map[string]any{"policy": policy}, nil
}

func (a *API) listInstances(w http.ResponseWriter, r *http.Request) (int, any, error) {
	return 200, map[string]any{"instances": a.Service.Statuses()}, nil
}

func (a *API) getInstance(w http.ResponseWriter, r *http.Request) (int, any, error) {
	s, err := a.Service.Get(r.PathValue("id"))
	return 200, s, err
}

func command(s instances.Status, err error, conflict bool) (int, any, error) {
	if err != nil {
		return 0, nil, err
	}
	if s.Unmanaged || conflict {
		msg := "Worker has not stopped"
		if s.LastError != nil {
			msg = *s.LastError
		}
		return 0, nil, errBody(409, "worker_busy", msg)
	}
	return 200, s, nil
}

func (a *API) start(w http.ResponseWriter, r *http.Request) (int, any, error) {
	s, err := a.Service.Start(r.PathValue("id"))
	return command(s, err, false)
}

func (a *API) stop(w http.ResponseWriter, r *http.Request) (int, any, error) {
	s, err := a.Service.Stop(r.PathValue("id"))
	return command(s, err, err == nil && s.State != "stopped" && s.State != "failed")
}

func (a *API) restart(w http.ResponseWriter, r *http.Request) (int, any, error) {
	s, err := a.Service.Restart(r.PathValue("id"))
	return command(s, err, false)
}

func queryInt(r *http.Request, key string, def int) (int, error) {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, badRequest(fmt.Sprintf("invalid literal for int() with base 10: '%s'", v))
	}
	return n, nil
}

func (a *API) logs(w http.ResponseWriter, r *http.Request) (int, any, error) {
	after, err := queryInt(r, "after", 0)
	if err != nil {
		return 0, nil, err
	}
	limit, err := queryInt(r, "limit", 500)
	if err != nil {
		return 0, nil, err
	}
	limit = min(max(limit, 1), 2000)
	chunk, err := a.Service.Logs(r.PathValue("id"), int64(after), limit)
	return 200, chunk, err
}

func (a *API) tasks(w http.ResponseWriter, r *http.Request) (int, any, error) {
	t, err := a.Service.Tasks(r.PathValue("id"))
	return 200, t, err
}

var langPattern = regexp.MustCompile(`^[a-z]{2}-[A-Z]{2}$`)

func (a *API) configSchema(w http.ResponseWriter, r *http.Request) (int, any, error) {
	id := r.PathValue("id")
	if id == "" {
		id = "alas"
	} else if err := a.Service.Require(id); err != nil {
		return 0, nil, err
	}
	lang := r.URL.Query().Get("lang")
	if lang == "" {
		lang = "en-US"
	}
	if !langPattern.MatchString(lang) {
		return 0, nil, badRequest("lang must look like en-US")
	}
	var out json.RawMessage
	err := a.Config.Call("schema", map[string]any{"instance": id, "lang": lang}, &out)
	return 200, out, err
}

func (a *API) configRead(w http.ResponseWriter, r *http.Request) (int, any, error) {
	id := r.PathValue("id")
	if err := a.Service.Require(id); err != nil {
		return 0, nil, err
	}
	var out json.RawMessage
	err := a.Config.Call("read", map[string]any{"instance": id}, &out)
	return 200, out, err
}

func (a *API) configUpdate(w http.ResponseWriter, r *http.Request) (int, any, error) {
	id := r.PathValue("id")
	if err := a.Service.Require(id); err != nil {
		return 0, nil, err
	}
	body, err := readJSON(r)
	if err != nil {
		return 0, nil, err
	}
	obj, isObj := body.(map[string]any)
	var revision any
	if match := r.Header.Get("If-Match"); match != "" {
		revision = strings.Trim(match, `"`)
	} else if isObj {
		revision = obj["revision"]
	}
	rev, isStr := revision.(string)
	if !isObj || !isStr {
		return 0, nil, badRequest(`Body must be {"revision": "...", "changes": {"Task.Group.Arg": value}}`)
	}
	var out json.RawMessage
	err = a.Config.Call("update", map[string]any{"instance": id, "revision": rev, "changes": obj["changes"]}, &out)
	return 200, out, err
}

func (a *API) createProfile(w http.ResponseWriter, r *http.Request) (int, any, error) {
	body, err := readJSON(r)
	if err != nil {
		return 0, nil, err
	}
	obj, _ := body.(map[string]any)
	id, ok := obj["id"].(string)
	if obj == nil || !ok {
		return 0, nil, badRequest("Provide a profile name")
	}
	var source any
	if raw, present := obj["source"]; present && raw != nil {
		s, ok := raw.(string)
		if !ok {
			return 0, nil, badRequest("Provide a source profile name")
		}
		if err := a.Service.Require(s); err != nil {
			return 0, nil, err
		}
		source = s
	}
	if id != "alas" {
		for _, inst := range a.Service.List() {
			if strings.EqualFold(inst.ID, id) {
				return 0, nil, errBody(409, "profile_exists", "A profile with that name already exists")
			}
		}
	}
	if err := a.Config.Call("create", map[string]any{"instance": id, "source": source}, nil); err != nil {
		return 0, nil, err
	}
	s, err := a.Service.Get(id)
	return 201, s, err
}
