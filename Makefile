# MAT Audio Lab - Development Workflow

PID_FILE := /tmp/mat-port-forward.pid

.PHONY: build load apply restart status stop-forward port-forward ensure-port refresh-browser logs deploy stop html help

# Full build, deploy, port-forward, browser sync, and log streaming pipeline
deploy: build load apply restart status stop-forward port-forward ensure-port refresh-browser logs

# Individual steps
build:
	@echo "==> Building Docker image..."
	docker build -t mat-audio-lab:v0.1 .

load:
	@echo "==> Loading image into Kind cluster..."
	kind load docker-image mat-audio-lab:v0.1 --name audio-lab

apply:
	@echo "==> Applying Kubernetes manifests..."
	kubectl apply -f deployments/k8s/deployment.yaml

restart:
	@echo "==> Restarting Kubernetes deployment..."
	kubectl rollout restart deployment/mat-audio-lab

status:
	@echo "==> Waiting for new pod to become ready..."
	kubectl rollout status deployment/mat-audio-lab

stop-forward:
	@echo "==> Cleaning up existing port-forward..."
	@if [ -f $(PID_FILE) ]; then \
		kill -9 $$(cat $(PID_FILE)) 2>/dev/null || true; \
		rm -f $(PID_FILE); \
	fi
	@pgrep -f "kubectl port-forward svc/mat-audio-lab-service" | grep -v "$$$$" | xargs -r kill -9 2>/dev/null || true

port-forward: stop-forward
	@echo "==> Starting background port-forward (127.0.0.1:8080 -> 8080)..."
	@nohup kubectl port-forward svc/mat-audio-lab-service 8080:8080 >/dev/null 2>&1 & echo $$! > $(PID_FILE)

ensure-port:
	@echo "==> Checking port 8080 health..."
	@for i in $$(seq 1 10); do \
		if curl -s http://127.0.0.1:8080/healthz > /dev/null 2>&1; then \
			echo "==> Port 8080 is active!"; \
			exit 0; \
		fi; \
		sleep 0.5; \
	done; \
	echo "==> Port 8080 not responding. Restarting tunnel..."; \
	$(MAKE) port-forward; \
	for i in $$(seq 1 10); do \
		if curl -s http://127.0.0.1:8080/healthz > /dev/null 2>&1; then \
			echo "==> Port-forward re-established!"; \
			exit 0; \
		fi; \
		sleep 0.5; \
	done; \
	echo "==> [ERROR] Port-forward failed to connect."; \
	exit 1

refresh-browser: ensure-port
	@echo "==> Checking if page is already open in browser..."
	@if curl -s -f http://127.0.0.1:8080/api/check-browser > /dev/null 2>&1; then \
		echo "==> Page is already open. Existing tab will reconnect automatically."; \
	else \
		echo "==> Page is NOT open. Opening http://127.0.0.1:8080..."; \
		if command -v wslview >/dev/null 2>&1; then \
			wslview http://127.0.0.1:8080 >/dev/null 2>&1 & \
		elif [ -f /mnt/c/Windows/System32/cmd.exe ]; then \
			/mnt/c/Windows/System32/cmd.exe /c start http://127.0.0.1:8080 >/dev/null 2>&1 & \
		elif command -v cmd.exe >/dev/null 2>&1; then \
			cmd.exe /c start http://127.0.0.1:8080 >/dev/null 2>&1 & \
		else \
			python3 -c "import webbrowser; webbrowser.open('http://127.0.0.1:8080')" >/dev/null 2>&1 & \
		fi; \
	fi

logs:
	@echo "==> Streaming live logs (Press Ctrl+C to exit)..."
	-kubectl logs -f -l app=mat-audio-lab

stop:
	@echo "==> Stopping and removing Kubernetes deployment..."
	kubectl delete -f deployments/k8s/deployment.yaml --ignore-not-found=true
	@echo "==> Deployment terminated."