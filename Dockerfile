FROM golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /mat-audio-lab ./cmd/mat-audio-lab

FROM scratch

COPY --from=builder /app/web /web
COPY --from=builder /mat-audio-lab /mat-audio-lab

ENTRYPOINT ["/mat-audio-lab"]
