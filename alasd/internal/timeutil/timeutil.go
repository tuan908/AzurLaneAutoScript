// Package timeutil formats times the way the Python control plane did (datetime.isoformat in UTC).
package timeutil

import "time"

// ISO formats t like Python's datetime.isoformat(): microseconds only when non-zero, "+00:00" offset.
func ISO(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond()/1000 == 0 {
		return t.Format("2006-01-02T15:04:05+00:00")
	}
	return t.Format("2006-01-02T15:04:05.000000+00:00")
}

// ISOPtr returns nil for a nil time.
func ISOPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := ISO(*t)
	return &s
}

// Parse reads a time written by ISO, nil when empty or invalid.
func Parse(s *string) *time.Time {
	if s == nil || *s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		return nil
	}
	return &t
}
