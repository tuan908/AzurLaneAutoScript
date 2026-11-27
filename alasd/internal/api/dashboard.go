package api

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".map":   "application/json",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".webp":  "image/webp",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".wasm":  "application/wasm",
	".txt":   "text/plain; charset=utf-8",
}

// dashboardFiles serves the built dashboard. Unknown paths that ask for HTML get index.html
// (client-side routes like /dashboard/alas); HTML is never cached.
type dashboardFiles struct{ dir string }

func (d dashboardFiles) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := path.Clean("/" + r.URL.Path)
	if name == "/" {
		name = "/index.html"
	}
	file := filepath.Join(d.dir, filepath.FromSlash(name))
	st, err := os.Stat(file)
	if err != nil || st.IsDir() {
		first := strings.SplitN(strings.TrimPrefix(name, "/"), "/", 2)[0]
		if !strings.Contains(r.Header.Get("Accept"), "text/html") || first == "assets" {
			http.NotFound(w, r)
			return
		}
		file = filepath.Join(d.dir, "index.html")
		if _, err := os.Stat(file); err != nil {
			http.NotFound(w, r)
			return
		}
	}
	if strings.HasSuffix(file, ".html") {
		w.Header().Set("Cache-Control", "no-cache")
	}
	// The Windows registry can map .js to text/plain, which browsers refuse for modules
	if ct, ok := contentTypes[strings.ToLower(filepath.Ext(file))]; ok {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeFile(w, r, file)
}
