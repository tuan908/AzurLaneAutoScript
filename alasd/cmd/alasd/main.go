// alasd is the ALAS control server: the dashboard, the control API, and the owner of the Alas
// worker processes. It replaces control_server.py; Alas itself stays Python.
//
//	alasd [-p 22267] [--host 127.0.0.1] [--root .] [--python .venv/Scripts/python.exe] [-k password]
//	      [--fake-workers] [--run alas alas2]
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"alasd/internal/api"
	"alasd/internal/health"
	"alasd/internal/instances"
	"alasd/internal/sidecar"
	"alasd/internal/worker"
)

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

func defaultPython(root string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(root, ".venv", "Scripts", "python.exe")
	}
	return filepath.Join(root, ".venv", "bin", "python")
}

func main() {
	log.SetFlags(log.LstdFlags)
	port := flag.Int("p", 22267, "port")
	flag.IntVar(port, "port", 22267, "port")
	host := flag.String("host", "127.0.0.1", "address to listen on")
	root := flag.String("root", ".", "ALAS folder")
	python := flag.String("python", "", "Python of ALAS (default: .venv in the ALAS folder)")
	key := flag.String("k", "", "password of the API (default: Password in config/deploy.yaml)")
	flag.StringVar(key, "key", "", "password of the API")
	fakeWorkers := flag.Bool("fake-workers", false, "run dev_tools/fake_worker.py instead of Alas (dashboard smoke tests)")
	var runs stringList
	flag.Var(&runs, "run", "instance to start at launch, repeat or list after the flags")
	flag.Parse()
	// `--run alas alas2` as control_server.py accepted it
	runs = append(runs, flag.Args()...)

	absRoot, err := filepath.Abs(*root)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(absRoot, "module", "control", "worker.py")); err != nil {
		log.Fatalf("%s is not an ALAS folder (module/control/worker.py is missing)", absRoot)
	}
	py := *python
	if py == "" {
		py = defaultPython(absRoot)
	}
	if _, err := os.Stat(py); err != nil {
		log.Fatalf("Python not found at %s; run `uv sync` in %s or pass --python", py, absRoot)
	}

	config := &sidecar.Client{Root: absRoot, Command: []string{py, "-m", "module.control.sidecar"}}
	defer config.Close()
	var deploy struct {
		Password *string  `json:"password"`
		Run      []string `json:"run"`
	}
	if err := config.Call("deploy", nil, &deploy); err != nil {
		log.Printf("Cannot read config/deploy.yaml: %v", err)
	}
	password := *key
	if password == "" && deploy.Password != nil {
		password = *deploy.Password
	}
	if len(runs) == 0 {
		runs = deploy.Run
	}

	workerConfig := worker.Config{Root: absRoot, Python: []string{py}}
	if *fakeWorkers {
		workerConfig.Command = func(id, fn string) []string {
			return []string{py, filepath.Join("dev_tools", "fake_worker.py"), id, fn}
		}
		log.Printf("Fake workers: instances run dev_tools/fake_worker.py, not Alas")
	}
	registry := worker.NewRegistry(workerConfig)
	service := &instances.Service{Root: absRoot, Workers: registry, Config: config}
	monitor := health.NewMonitor(service, health.NewPolicyStore(absRoot))
	service.Health = monitor.InstanceHealth

	var shuttingDown atomic.Bool
	server := api.New(&api.API{
		Root: absRoot, Service: service, Config: config, Monitor: monitor, Password: password,
		ShuttingDown: shuttingDown.Load,
	})

	addr := net.JoinHostPort(*host, strconv.Itoa(*port))
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("Cannot listen on %s: %v", addr, err)
	}
	httpServer := &http.Server{Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Printf("ALAS control server on http://%s/dashboard/ (root %s, python %s, password %t)",
		addr, absRoot, py, password != "")

	monitor.Start()
	startInstances(service, runs, absRoot)

	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.Serve(listener) }()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	select {
	case sig := <-signals:
		log.Printf("Received %s, shutting down", sig)
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("Server stopped: %v", err)
		}
	}

	// Event streams end first, then recovery stops before the workers, so a shutdown is never "recovered"
	shuttingDown.Store(true)
	monitor.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = httpServer.Shutdown(ctx)
	cancel()
	var wg sync.WaitGroup
	for _, m := range registry.All() {
		wg.Add(1)
		go func(m *worker.Manager) {
			defer wg.Done()
			m.Stop()
		}(m)
	}
	wg.Wait()
	log.Printf("ALAS control server stopped")
}

// startInstances started at launch: --run, Run in deploy.yaml, and config/reloadalas left by an update.
func startInstances(service *instances.Service, runs []string, root string) {
	reload := filepath.Join(root, "config", "reloadalas")
	if data, err := os.ReadFile(reload); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if line = strings.TrimSpace(line); line != "" {
				runs = append(runs, line)
			}
		}
		_ = os.Remove(reload)
	}
	seen := map[string]bool{}
	for _, id := range runs {
		if seen[id] {
			continue
		}
		seen[id] = true
		if _, err := service.Start(id); err != nil {
			log.Printf("Cannot start %s: %v", id, err)
		} else {
			log.Printf("Started %s", id)
		}
	}
	if len(seen) > 0 {
		fmt.Println()
	}
}
