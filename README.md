# MAT Audio Lab

> **In active development**

MAT Audio Lab is a locally deployed web application for reaction-time testing and audio-assisted input-delay calibration. It combines a Go HTTP/DSP backend with a vanilla HTML/CSS/JavaScript frontend and runs in a local Kind Kubernetes cluster.

## Current Features

- Browser-based reaction speed test using `pointerdown` timing.
- Session input-delay calibration using the computer's physical speakers, microphone, and mouse.
- Acoustic loopback calibration with one warm-up probe and five measured chirp probes.
- Three physical mouse presses per calibration run for a more robust input-delay estimate.
- Go-side WAV/PCM analysis using matched-filter probe detection, mouse transient detection, median/MAD statistics, and probe outlier rejection.
- Automatic application status/heartbeat reporting in the UI.
- Browser-presence detection so the development workflow avoids opening duplicate tabs when possible.
- Dockerized Go application deployed locally through Kind/Kubernetes.

## Architecture

### Backend

The backend is written in Go and listens on port `8080`. It:

- serves the frontend from `./web`;
- exposes health, status, and browser-presence endpoints;
- handles the two UI button API calls;
- accepts 32-bit float WAV uploads for calibration analysis;
- performs acoustic probe and mouse-transient DSP;
- keeps uploaded WAV data in memory and can return it by generated WAV ID.

### Frontend

The frontend uses vanilla HTML, CSS, JavaScript, and the Web Audio API. The main files are:

```text
web/
├── index.html
├── styles.css
├── app.js
└── static/
    └── img/
        └── MAT Software Solutions Logo.png
```

The reaction test and calibration both use `pointerdown` rather than the DOM `click` event so the measured input event corresponds to the initial press rather than button release.

### Infrastructure

The local deployment path is:

```text
Browser
  ↓
127.0.0.1:8080
  ↓ kubectl port-forward
Kubernetes Service: mat-audio-lab-service
  ↓
Deployment: mat-audio-lab
  ↓
Go server :8080
```

The Kubernetes Service is configured as `NodePort` with node port `30080`, but the provided development Makefile normally accesses it through `kubectl port-forward` on `127.0.0.1:8080`.

## Repository Layout

```text
mat-audio-lab/
├── cmd/
│   └── mat-audio-lab/
│       └── main.go
├── deployments/
│   └── k8s/
│       └── deployment.yaml
├── pkg/
│   ├── backend/
│   │   ├── button1.go
│   │   └── button2.go
│   └── dsp/
│       └── audioParser.go
├── web/
│   ├── static/
│   │   └── img/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── Dockerfile
├── Makefile
├── go.mod
└── README.md
```

## Prerequisites

For the provided deployment workflow:

- Docker
- Kind
- kubectl
- GNU Make
- curl
- a Unix-like shell environment with standard utilities used by the Makefile (`pgrep`, `xargs`, `nohup`, `seq`, and `kill`)

The Makefile is designed primarily for Linux/WSL-style development environments. Its browser-opening logic includes WSL/Windows interoperability fallbacks and a Python `webbrowser` fallback, but the Makefile itself is not a native PowerShell/CMD workflow.

### Go Version

The project declares:

```text
go 1.25.0
```

and the Docker build uses:

```text
golang:1.25-alpine
```

A host Go installation is therefore **not required for `make deploy`**. Install Go 1.25+ locally only if you want to build, test, or work with the Go code outside Docker.

## Quick Start

### 1. Clone the repository

```bash
git clone <repository-url>
cd mat-audio-lab
```

### 2. Create the Kind cluster

The Makefile expects a Kind cluster named `audio-lab` to already exist:

```bash
kind create cluster --name audio-lab
```

You only need to create it once unless the cluster has been deleted.

### 3. Deploy the application

```bash
make deploy
```

`make deploy` runs the following pipeline:

1. Builds `mat-audio-lab:v0.1` with Docker.
2. Loads that image into the `audio-lab` Kind cluster.
3. Applies `deployments/k8s/deployment.yaml`.
4. Restarts the `mat-audio-lab` Deployment.
5. Waits for the rollout to become ready.
6. Cleans up an existing MAT Audio Lab port-forward, if present.
7. Starts `127.0.0.1:8080 -> mat-audio-lab-service:8080` in the background.
8. Checks `http://127.0.0.1:8080/healthz` and retries the tunnel if necessary.
9. Checks whether the UI is already open and attempts to open it if needed.
10. Streams the application logs.

The application is then available at:

```text
http://127.0.0.1:8080
```

Press `Ctrl+C` to leave the live log stream. This does not delete the Kubernetes deployment.

## Input-Delay Calibration

Before relying on corrected reaction times, use **Calibrate Input Delay** in the Reaction Speed Test panel.

For the current calibration path:

- use physical speakers rather than headphones;
- allow microphone access in the browser;
- keep the microphone unobstructed;
- use an audible speaker volume;
- keep the speaker, microphone, and mouse positions unchanged during calibration;
- do not click while the acoustic probes are playing;
- when prompted, perform three mouse presses at least roughly half a second apart.

The browser records one continuous microphone stream while it plays one discarded warm-up chirp followed by five measured chirps. It then records three mouse presses on the same audio timeline. The WAV and timing metadata are sent to the Go DSP backend, which analyzes the probes and mouse transients and returns calibration statistics. The accepted session correction is applied to subsequent reaction-test results.

Calibration requires browser support for `AudioContext.getOutputTimestamp()`.

## Makefile Commands

### Full workflow

```bash
make deploy
```

Builds, loads, deploys, restarts, waits for readiness, starts the port-forward, checks the browser, and streams logs.

### Build the Docker image

```bash
make build
```

Builds:

```text
mat-audio-lab:v0.1
```

### Load the image into Kind

```bash
make load
```

Loads the image into the Kind cluster named `audio-lab`.

### Apply Kubernetes manifests

```bash
make apply
```

Applies:

```text
deployments/k8s/deployment.yaml
```

### Restart the Deployment

```bash
make restart
```

Restarts the `mat-audio-lab` Deployment.

### Wait for rollout readiness

```bash
make status
```

Waits for the Deployment rollout to complete.

### Start the local port-forward

```bash
make port-forward
```

Starts a background tunnel:

```text
127.0.0.1:8080 -> mat-audio-lab-service:8080
```

The process ID is stored at:

```text
/tmp/mat-port-forward.pid
```

### Stop the local port-forward

```bash
make stop-forward
```

Stops the MAT Audio Lab `kubectl port-forward` process and removes its PID file.

### Check the local port

```bash
make ensure-port
```

Checks `/healthz` on port `8080` and attempts to restart the port-forward if the health check fails.

### Refresh/open the browser

```bash
make refresh-browser
```

Checks `/api/check-browser`. If no active UI heartbeat has been seen recently, the Makefile attempts to open `http://127.0.0.1:8080`.

### Stream logs

```bash
make logs
```

Streams logs from pods with:

```text
app=mat-audio-lab
```

### Remove Kubernetes resources

```bash
make stop
```

Deletes the resources defined in `deployments/k8s/deployment.yaml`.

This does **not** delete the Kind cluster or Docker image. If you also want to terminate the background port-forward explicitly, run:

```bash
make stop-forward
```

## HTTP Endpoints

The Go server currently exposes:

| Endpoint | Method | Purpose |
|---|---:|---|
| `/` | GET | Serves the frontend/static files |
| `/healthz` | GET | Health check used by the development workflow |
| `/api/status` | GET | Returns engine status, UTC time, and environment |
| `/api/presence` | POST | Receives the browser heartbeat |
| `/api/check-browser` | GET | Reports whether a recent UI heartbeat has been seen |
| `/api/button1` | POST | Backend handler used by the first expandable UI control |
| `/api/button2` | POST | Backend handler used by the second expandable UI control |
| `/api/audio-upload` | POST | Accepts WAV calibration/measurement data for DSP analysis |
| `/api/audio-fetch?wav_id=...` | GET | Returns a previously uploaded WAV held in memory |

## Kubernetes Configuration

The included manifest creates:

- one `mat-audio-lab` Deployment replica;
- container port `8080`;
- image `mat-audio-lab:v0.1`;
- `imagePullPolicy: Never`, because the image is loaded directly into Kind;
- a `NodePort` Service named `mat-audio-lab-service`;
- service port `8080`;
- node port `30080`.

The Deployment uses the `Recreate` strategy and is intended for local development.

## Development Notes

- The container is built as a multi-stage image. Go compilation happens in `golang:1.25-alpine`, while the runtime image is `scratch` and contains only the compiled application and the `web` directory.
- Uploaded WAVs are stored in an in-memory Go map. They are not persisted across application restarts.
- The current UI includes a second expandable button/workspace that is still a placeholder.
- The project is under active development, so calibration behavior and UI controls may continue to change.
