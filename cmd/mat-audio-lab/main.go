package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
	"mat-audio-lab/pkg/backend"
	"mat-audio-lab/pkg/dsp"
)

type EngineStatus struct {
	Status      string `json:"status"`
	Time        string `json:"time"`
	Environment string `json:"environment"`
}

var (
	activeTabs   int
	lastSeenTab  time.Time
	presenceLock sync.Mutex
)

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
		presenceLock.Lock()
		lastSeenTab = time.Now()
		presenceLock.Unlock()
		w.WriteHeader(http.StatusOK)
	})

	// Endpoint queried by Makefile to check if page is already open in a browser
	http.HandleFunc("/api/check-browser", func(w http.ResponseWriter, r *http.Request) {
		presenceLock.Lock()
		defer presenceLock.Unlock()

		if time.Since(lastSeenTab) < 15*time.Second {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("OPEN"))
			return
		}

		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("CLOSED"))
	})

	// Serve static assets from ./web
	fs := http.FileServer(http.Dir("./web"))
	http.Handle("/", fs)

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