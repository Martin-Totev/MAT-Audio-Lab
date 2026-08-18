package main

import (
	"encoding/json"
	"fmt"
	"mat-audio-lab/pkg/backend"
	"mat-audio-lab/pkg/dsp"
	"net/http"
	"os"
	"sync"
	"time"
)

type EngineStatus struct {
	Status      string `json:"status"`
	Time        string `json:"time"`
	Environment string `json:"environment"`
}

const browserPresenceTTL = 4 * time.Second

type BrowserTabPresence struct {
	Host     string
	LastSeen time.Time
}

var (
	browserTabs  = make(map[string]BrowserTabPresence)
	presenceLock sync.Mutex
)

func browserTabKey(r *http.Request) string {
	tabID := r.URL.Query().Get("tab_id")
	if tabID == "" {
		tabID = "legacy"
	}
	return r.Host + "|" + tabID
}

func main() {
	fmt.Println("=================================================================")
	fmt.Println("                    MAT AUDIO LAB v0.1                          ")
	fmt.Println("  [!] Engine: Web UI serving with cross-platform tab detection   ")
	fmt.Println("=================================================================")

	// Background worker logging debug info to terminal
	go func() {
		for {
			fmt.Printf("[%s UTC] [DEBUG] Engine pulse active...\n", time.Now().UTC().Format("15:04:05"))
			time.Sleep(5 * time.Second)
		}
	}()

	// Frontend status endpoint
	http.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		envDisplay := "Go (Local)"
		if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
			envDisplay = "Kubernetes"
		}
		status := EngineStatus{
			Status:      "running",
			Time:        time.Now().UTC().Format("15:04:05"),
			Environment: envDisplay,
		}
		json.NewEncoder(w).Encode(status)
	})

	// Heartbeat sent by open index.html tabs every second
	http.HandleFunc("/api/presence", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		presenceLock.Lock()
		browserTabs[browserTabKey(r)] = BrowserTabPresence{
			Host:     r.Host,
			LastSeen: time.Now(),
		}
		presenceLock.Unlock()
		w.WriteHeader(http.StatusOK)
	})

	http.HandleFunc("/api/presence/close", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		presenceLock.Lock()
		delete(browserTabs, browserTabKey(r))
		presenceLock.Unlock()
		w.WriteHeader(http.StatusOK)
	})

	// Endpoint queried by Makefile to check if page is already open in a browser
	http.HandleFunc("/api/check-browser", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		presenceLock.Lock()
		defer presenceLock.Unlock()

		now := time.Now()
		canonicalTabOpen := false
		for key, presence := range browserTabs {
			if now.Sub(presence.LastSeen) >= browserPresenceTTL {
				delete(browserTabs, key)
				continue
			}
			if presence.Host == r.Host {
				canonicalTabOpen = true
			}
		}

		if canonicalTabOpen {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("OPEN"))
			return
		}

		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("CLOSED"))
	})

	// Serve static assets from ./web
	fs := http.FileServer(http.Dir("./web"))
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		fs.ServeHTTP(w, r)
	}))

	// Health check endpoint for Kubernetes
	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})
	// API Handler for Button 1
	http.HandleFunc("/api/button1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		resp := backend.ExecuteButton1()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	// API Handler for Button 2
	http.HandleFunc("/api/button2", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		resp := backend.ExecuteButton2()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	http.HandleFunc("/api/audio-upload", dsp.ReceiveRawWav)
	http.HandleFunc("/api/audio-fetch", dsp.ReturnRawWav)
	fmt.Println("[INIT] Starting HTTP Server on :8080...")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		fmt.Printf("[FATAL] Server failed: %v\n", err)
	}
}
