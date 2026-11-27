package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"alasd/internal/health"
	"alasd/internal/instances"
)

const (
	eventsPoll      = 500 * time.Millisecond
	eventsHeartbeat = 15 * time.Second
	eventsMaxLines  = 200
	eventsSendLimit = 5 * time.Second
)

// events streams server-sent events. Each connection keeps cursors only (last status key and
// last log seq per instance) and reads the bounded log tails, so a slow browser never holds
// memory or blocks a worker. After a reconnect the client refetches the REST snapshot.
func (a *API) events(w http.ResponseWriter, r *http.Request) {
	if e := a.refuse(r); e != nil {
		writeJSON(w, e.status, e.body)
		return
	}
	a.eventConnections.Add(1)
	defer a.eventConnections.Add(-1)
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)

	send := func(chunk string) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(eventsSendLimit))
		if _, err := w.Write([]byte(chunk)); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	sse := func(kind string, data any, id int) string {
		payload, _ := json.Marshal(data)
		head := ""
		if id > 0 {
			head = fmt.Sprintf("id: %d\n", id)
		}
		return fmt.Sprintf("%sevent: %s\ndata: %s\n\n", head, kind, payload)
	}

	statusSeen := map[string]string{}
	logSeen := map[string]int64{}
	for _, s := range a.Service.Statuses() {
		if chunk, err := a.Service.Logs(s.ID, 0, 1); err == nil {
			logSeen[s.ID] = chunk.LastSeq
		}
	}
	eventID := 0
	lastBeat := time.Now()
	if !send("retry: 3000\n\n") || !send(sse("resync", map[string]string{"streamId": a.streamID}, 0)) {
		return
	}
	ticker := time.NewTicker(eventsPoll)
	defer ticker.Stop()
	for !a.ShuttingDown() {
		statuses := a.Service.Statuses()
		active := map[string]bool{}
		for _, s := range statuses {
			active[s.ID] = true
		}
		for id := range statusSeen {
			if !active[id] {
				delete(statusSeen, id)
				delete(logSeen, id)
			}
		}
		for _, s := range statuses {
			id := s.ID
			if key := statusKey(s); statusSeen[id] != key {
				statusSeen[id] = key
				eventID++
				if !send(sse("instance.status.changed", map[string]any{"instanceId": id, "data": s}, eventID)) {
					return
				}
			}
			seen, ok := logSeen[id]
			if !ok {
				// Start at the current end; the backlog comes from /logs
				if chunk, err := a.Service.Logs(id, 0, 1); err == nil {
					logSeen[id] = chunk.LastSeq
				}
				continue
			}
			chunk, err := a.Service.Logs(id, seen, eventsMaxLines)
			if err != nil || len(chunk.Lines) == 0 {
				continue
			}
			missed := chunk.Lines[0].Seq > seen+1
			logSeen[id] = chunk.LastSeq
			if missed && !send(sse("resync", map[string]string{"streamId": a.streamID}, 0)) {
				return
			}
			eventID++
			if !send(sse("log.appended", map[string]any{"instanceId": id, "lines": chunk.Lines}, eventID)) {
				return
			}
		}
		if time.Since(lastBeat) >= eventsHeartbeat {
			lastBeat = time.Now()
			if !send(": ping\n\n") {
				return
			}
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

// statusKey changes when the dashboard should get a new status of an instance.
func statusKey(s instances.Status) string {
	var h health.InstanceHealth
	if v, ok := s.Health.(health.InstanceHealth); ok {
		h = v
	}
	stalledDetail := ""
	if h.State == "stalled" {
		stalledDetail = h.Detail
	}
	task := ""
	if s.CurrentTask != nil {
		task = *s.CurrentTask
	}
	next := ""
	if h.Recovery.NextAttemptAt != nil {
		next = *h.Recovery.NextAttemptAt
	}
	policy, _ := json.Marshal(h.Recovery.Policy)
	return fmt.Sprintf("%d|%s|%s|%t|%s|%s|%s|%t|%d|%s", s.Revision, s.State, task, s.Unmanaged, h.State,
		stalledDetail, next, h.Recovery.GaveUp, h.Recovery.RestartsLastHour, policy)
}
