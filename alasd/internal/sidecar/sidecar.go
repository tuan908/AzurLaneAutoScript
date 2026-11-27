// Package sidecar talks to `python -m module.control.sidecar`, which owns the Alas config logic
// (schema, revision-checked edits, the scheduler queue). One request at a time, JSON lines.
// The process is started on first use and again after it died.
package sidecar

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	"alasd/internal/worker"
)

// Error returned by a sidecar method, the Python exception.
type Error struct {
	Type     string            `json:"type"`
	Message  string            `json:"message"`
	Revision string            `json:"revision,omitempty"`
	Errors   map[string]string `json:"errors,omitempty"`
}

func (e *Error) Error() string { return e.Type + ": " + e.Message }

// ErrUnavailable: the sidecar could not be started or answered nothing.
var ErrUnavailable = errors.New("config helper is not available")

type Client struct {
	Root    string
	Command []string // e.g. [python, -m, module.control.sidecar]
	Timeout time.Duration

	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan []byte
	nextID int64
}

func (c *Client) ensure() error {
	if c.cmd != nil {
		return nil
	}
	cmd := exec.Command(c.Command[0], c.Command[1:]...)
	cmd.Dir = c.Root
	cmd.Env = append(os.Environ(), "PYTHONIOENCODING=utf-8", "PYTHONUNBUFFERED=1")
	cmd.Stderr = prefixWriter{"[config] "}
	worker.Detach(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	lines := make(chan []byte, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
		for sc.Scan() {
			lines <- append([]byte(nil), sc.Bytes()...)
		}
		close(lines)
		_ = cmd.Wait()
	}()
	c.cmd, c.stdin, c.lines = cmd, stdin, lines
	return nil
}

func (c *Client) reset() {
	if c.cmd != nil {
		_ = c.stdin.Close()
		_ = c.cmd.Process.Kill()
	}
	c.cmd, c.stdin, c.lines = nil, nil, nil
}

// Call a method; result is decoded into out (may be nil).
func (c *Client) Call(method string, params map[string]any, out any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(); err != nil {
		return err
	}
	c.nextID++
	id := c.nextID
	req, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return err
	}
	if _, err := c.stdin.Write(append(req, '\n')); err != nil {
		c.reset()
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case line, ok := <-c.lines:
			if !ok {
				c.reset()
				return fmt.Errorf("%w: it exited", ErrUnavailable)
			}
			var resp struct {
				ID     int64           `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  *Error          `json:"error"`
			}
			if err := json.Unmarshal(line, &resp); err != nil || resp.ID != id {
				continue
			}
			if resp.Error != nil {
				return resp.Error
			}
			if out != nil {
				return json.Unmarshal(resp.Result, out)
			}
			return nil
		case <-timer.C:
			c.reset()
			return fmt.Errorf("%w: no answer to %s in %s", ErrUnavailable, method, timeout)
		}
	}
}

// Close stops the sidecar.
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cmd != nil {
		_ = c.stdin.Close()
		done := make(chan struct{})
		go func() {
			for range c.lines {
			}
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = c.cmd.Process.Kill()
		}
	}
	c.cmd, c.stdin, c.lines = nil, nil, nil
}

type prefixWriter struct{ prefix string }

func (w prefixWriter) Write(p []byte) (int, error) {
	log.Printf("%s%s", w.prefix, string(p))
	return len(p), nil
}
