package dsp

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"
)

var (
	wavStore   = make(map[string][]byte)
	storeMutex sync.RWMutex
)

const (
	probeDurationMs = 15.0
	probeStartHz    = 1800.0
	probeEndHz      = 7000.0
	minProbeCorr    = 0.15
)

type ProbeResult struct {
	ExpectedOffsetMs float64 `json:"expected_offset_ms"`
	DetectedOffsetMs float64 `json:"detected_offset_ms"`
	DelayMs          float64 `json:"delay_ms"`
	Correlation      float64 `json:"correlation"`
	Accepted         bool    `json:"accepted"`
}

type MouseResult struct {
	PointerOffsetMs  float64 `json:"pointer_offset_ms"`
	DetectedOffsetMs float64 `json:"detected_offset_ms"`
	DeltaMs          float64 `json:"delta_ms"`
}

type AudioResponse struct {
	Status             string        `json:"status"`
	WavID              string        `json:"wav_id"`
	ClickOffsetMs      float64       `json:"click_offset_ms"`
	MouseResults       []MouseResult `json:"mouse_results,omitempty"`
	MouseDeltaMedianMs float64       `json:"mouse_delta_median_ms"`
	MouseDeltaMADMs    float64       `json:"mouse_delta_mad_ms"`
	MouseDeltaRangeMs  float64       `json:"mouse_delta_range_ms"`
	ProbeResults       []ProbeResult `json:"probe_results,omitempty"`
	ProbeDelayMedianMs float64       `json:"probe_delay_median_ms"`
	ProbeDelayMADMs    float64       `json:"probe_delay_mad_ms"`
	ProbeDelayRangeMs  float64       `json:"probe_delay_range_ms"`
	Message            string        `json:"message"`
	Mode               string        `json:"mode"`
}

type decodedWAV struct {
	sampleRate float64
	samples    []float64
}

func generateWavID(audioData []byte) string {
	hash := sha256.Sum256(audioData)
	return hex.EncodeToString(hash[:])[:16]
}

func decodeFloat32WAV(wavBytes []byte) (decodedWAV, error) {
	const headerSize = 44
	if len(wavBytes) <= headerSize {
		return decodedWAV{}, fmt.Errorf("WAV payload too small")
	}

	sampleRate := float64(binary.LittleEndian.Uint32(wavBytes[24:28]))
	if sampleRate <= 0 {
		return decodedWAV{}, fmt.Errorf("invalid WAV sample rate")
	}

	pcmData := wavBytes[headerSize:]
	sampleCount := len(pcmData) / 4
	if sampleCount == 0 {
		return decodedWAV{}, fmt.Errorf("WAV contains no samples")
	}

	samples := make([]float64, sampleCount)
	for i := 0; i < sampleCount; i++ {
		bits := binary.LittleEndian.Uint32(pcmData[i*4 : (i+1)*4])
		samples[i] = float64(math.Float32frombits(bits))
	}

	return decodedWAV{sampleRate: sampleRate, samples: samples}, nil
}

// buildProbeTemplate mirrors the browser's 15 ms Hann-windowed linear chirp.
func buildProbeTemplate(sampleRate float64) []float64 {
	sampleCount := int(math.Round(sampleRate * probeDurationMs / 1000.0))
	if sampleCount < 2 {
		sampleCount = 2
	}

	template := make([]float64, sampleCount)
	durationSeconds := float64(sampleCount) / sampleRate
	sweepRate := (probeEndHz - probeStartHz) / durationSeconds

	for i := 0; i < sampleCount; i++ {
		t := float64(i) / sampleRate
		phase := 2.0 * math.Pi * (probeStartHz*t + 0.5*sweepRate*t*t)
		window := 0.5 - 0.5*math.Cos((2.0*math.Pi*float64(i))/float64(sampleCount-1))
		template[i] = math.Sin(phase) * window
	}

	return template
}

func normalizedCorrelationAt(samples, template, prefixSquares []float64, lag int, templateEnergy float64) float64 {
	if lag < 0 || lag+len(template) > len(samples) {
		return 0
	}

	segmentEnergy := prefixSquares[lag+len(template)] - prefixSquares[lag]
	if segmentEnergy <= 1e-12 || templateEnergy <= 1e-12 {
		return 0
	}

	var dot float64
	for i, v := range template {
		dot += samples[lag+i] * v
	}

	corr := dot / math.Sqrt(segmentEnergy*templateEnergy)
	if corr < 0 {
		corr = -corr
	}
	return corr
}

// detectProbe uses a normalized matched filter in a narrow window around the
// browser's expected physical-speaker emission time. The broad pass advances by
// four samples, then the best candidate is refined sample-by-sample.
func detectProbe(wav decodedWAV, expectedOffsetMs float64) (float64, float64) {
	template := buildProbeTemplate(wav.sampleRate)
	if len(template) >= len(wav.samples) {
		return -1, 0
	}

	// The effective speaker->microphone reference delay should normally be
	// positive, but allow some negative room for JS sample-zero estimation error.
	searchStartMs := expectedOffsetMs - 60.0
	searchEndMs := expectedOffsetMs + 240.0
	if searchStartMs < 0 {
		searchStartMs = 0
	}

	start := int(math.Round(searchStartMs * wav.sampleRate / 1000.0))
	end := int(math.Round(searchEndMs * wav.sampleRate / 1000.0))
	maxLag := len(wav.samples) - len(template)
	if end > maxLag {
		end = maxLag
	}
	if start < 0 {
		start = 0
	}
	if start > end {
		return -1, 0
	}

	prefixSquares := make([]float64, len(wav.samples)+1)
	for i, sample := range wav.samples {
		prefixSquares[i+1] = prefixSquares[i] + sample*sample
	}

	var templateEnergy float64
	for _, v := range template {
		templateEnergy += v * v
	}

	bestLag := -1
	bestCorr := 0.0
	const coarseStep = 4

	for lag := start; lag <= end; lag += coarseStep {
		corr := normalizedCorrelationAt(wav.samples, template, prefixSquares, lag, templateEnergy)
		if corr > bestCorr {
			bestCorr = corr
			bestLag = lag
		}
	}

	if bestLag < 0 {
		return -1, 0
	}

	refineStart := bestLag - coarseStep*2
	refineEnd := bestLag + coarseStep*2
	if refineStart < start {
		refineStart = start
	}
	if refineEnd > end {
		refineEnd = end
	}

	for lag := refineStart; lag <= refineEnd; lag++ {
		corr := normalizedCorrelationAt(wav.samples, template, prefixSquares, lag, templateEnergy)
		if corr > bestCorr {
			bestCorr = corr
			bestLag = lag
		}
	}

	if bestCorr < minProbeCorr {
		return -1, bestCorr
	}

	return float64(bestLag) / wav.sampleRate * 1000.0, bestCorr
}

// findClickTransientNearMs keeps the earlier simple transient detector but limits
// it to a small window around the browser pointerdown hint. This prevents the five
// deliberately loud calibration chirps from ever being mistaken for the mouse.
func findClickTransientNearMs(wav decodedWAV, pointerOffsetMs float64) float64 {
	searchStartMs := pointerOffsetMs - 80.0
	searchEndMs := pointerOffsetMs + 160.0
	if searchStartMs < 20.0 {
		searchStartMs = 20.0
	}

	startSample := int(math.Round(searchStartMs * wav.sampleRate / 1000.0))
	endSample := int(math.Round(searchEndMs * wav.sampleRate / 1000.0))
	if startSample < 0 {
		startSample = 0
	}
	if endSample > len(wav.samples) {
		endSample = len(wav.samples)
	}
	if startSample >= endSample {
		return -1
	}

	maxPeak := 0.0
	for i := startSample; i < endSample; i++ {
		v := math.Abs(wav.samples[i])
		if v > maxPeak {
			maxPeak = v
		}
	}

	if maxPeak < 0.02 {
		return -1
	}

	threshold := maxPeak * 0.30
	for i := startSample; i < endSample; i++ {
		if math.Abs(wav.samples[i]) >= threshold {
			return float64(i) / wav.sampleRate * 1000.0
		}
	}

	return -1
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return math.NaN()
	}
	copyValues := append([]float64(nil), values...)
	sort.Float64s(copyValues)
	mid := len(copyValues) / 2
	if len(copyValues)%2 == 1 {
		return copyValues[mid]
	}
	return (copyValues[mid-1] + copyValues[mid]) / 2.0
}

func summarizeValues(values []float64) (float64, float64, float64) {
	if len(values) == 0 {
		return -1, -1, -1
	}

	med := median(values)
	deviations := make([]float64, len(values))
	minValue := values[0]
	maxValue := values[0]
	for i, value := range values {
		deviations[i] = math.Abs(value - med)
		if value < minValue {
			minValue = value
		}
		if value > maxValue {
			maxValue = value
		}
	}

	return med, median(deviations), maxValue - minValue
}

// rejectProbeOutliers marks only robustly consistent matched probes as accepted.
// With five probes, the median/MAD estimate is resistant to one bad reflection or
// mis-match. The 1 ms floor avoids over-rejecting tiny harmless timing variation
// when MAD is near zero.
func rejectProbeOutliers(results []ProbeResult) []ProbeResult {
	candidateDelays := make([]float64, 0, len(results))
	for _, result := range results {
		if result.DetectedOffsetMs >= 0 && result.Correlation >= minProbeCorr {
			candidateDelays = append(candidateDelays, result.DelayMs)
		}
	}

	if len(candidateDelays) == 0 {
		return results
	}

	med, mad, _ := summarizeValues(candidateDelays)
	maxDeviation := math.Max(1.0, 4.0*mad)

	for i := range results {
		results[i].Accepted = results[i].DetectedOffsetMs >= 0 &&
			results[i].Correlation >= minProbeCorr &&
			math.Abs(results[i].DelayMs-med) <= maxDeviation
	}

	return results
}

func summarizeAcceptedProbeDelays(results []ProbeResult) (float64, float64, float64) {
	delays := make([]float64, 0, len(results))
	for _, result := range results {
		if result.Accepted {
			delays = append(delays, result.DelayMs)
		}
	}
	return summarizeValues(delays)
}

func ReceiveRawWav(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := r.ParseMultipartForm(10 << 20); err != nil {
		http.Error(w, "Failed to parse audio payload", http.StatusBadRequest)
		return
	}

	mode := r.FormValue("mode")
	if mode != "latency_test" && mode != "measurement" {
		http.Error(w, "Invalid audio processing mode", http.StatusBadRequest)
		return
	}

	file, _, err := r.FormFile("audio")
	if err != nil {
		http.Error(w, "Audio file missing", http.StatusBadRequest)
		return
	}
	defer file.Close()

	audioData, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Failed to read audio", http.StatusInternalServerError)
		return
	}

	wavID := fmt.Sprintf("wav_%s", generateWavID(audioData))
	storeMutex.Lock()
	wavStore[wavID] = audioData
	storeMutex.Unlock()

	wav, err := decodeFloat32WAV(audioData)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	response := AudioResponse{
		Status:             "success",
		WavID:              wavID,
		ClickOffsetMs:      -1,
		MouseDeltaMedianMs: -1,
		MouseDeltaMADMs:    -1,
		MouseDeltaRangeMs:  -1,
		ProbeDelayMedianMs: -1,
		ProbeDelayMADMs:    -1,
		ProbeDelayRangeMs:  -1,
		Message:            "Audio processed",
		Mode:               mode,
	}

	if mode == "measurement" {
		var pointerOffsetsMs []float64
		pointerJSON := r.FormValue("pointer_offsets_ms")
		if pointerJSON != "" {
			if err := json.Unmarshal([]byte(pointerJSON), &pointerOffsetsMs); err != nil {
				http.Error(w, "Invalid pointer_offsets_ms", http.StatusBadRequest)
				return
			}
		} else {
			// Backward-compatible single-pointer fallback.
			pointerOffsetMs, err := strconv.ParseFloat(r.FormValue("pointer_offset_ms"), 64)
			if err == nil {
				pointerOffsetsMs = []float64{pointerOffsetMs}
			}
		}

		if len(pointerOffsetsMs) == 0 {
			http.Error(w, "No pointer offsets supplied", http.StatusBadRequest)
			return
		}
		for _, pointerOffsetMs := range pointerOffsetsMs {
			if math.IsNaN(pointerOffsetMs) || math.IsInf(pointerOffsetMs, 0) || pointerOffsetMs < 0 {
				http.Error(w, "Invalid pointer_offsets_ms", http.StatusBadRequest)
				return
			}
		}

		var expectedProbeOffsets []float64
		if err := json.Unmarshal([]byte(r.FormValue("probe_expected_offsets_ms")), &expectedProbeOffsets); err != nil || len(expectedProbeOffsets) == 0 {
			http.Error(w, "Invalid probe_expected_offsets_ms", http.StatusBadRequest)
			return
		}

		response.ProbeResults = make([]ProbeResult, 0, len(expectedProbeOffsets))
		for _, expectedOffsetMs := range expectedProbeOffsets {
			detectedOffsetMs, correlation := detectProbe(wav, expectedOffsetMs)
			delayMs := -1.0
			if detectedOffsetMs >= 0 {
				delayMs = detectedOffsetMs - expectedOffsetMs
			}

			response.ProbeResults = append(response.ProbeResults, ProbeResult{
				ExpectedOffsetMs: expectedOffsetMs,
				DetectedOffsetMs: detectedOffsetMs,
				DelayMs:          delayMs,
				Correlation:      correlation,
			})
		}

		response.ProbeResults = rejectProbeOutliers(response.ProbeResults)
		medianDelay, madDelay, rangeDelay := summarizeAcceptedProbeDelays(response.ProbeResults)
		response.ProbeDelayMedianMs = medianDelay
		response.ProbeDelayMADMs = madDelay
		response.ProbeDelayRangeMs = rangeDelay

		response.MouseResults = make([]MouseResult, 0, len(pointerOffsetsMs))
		mouseDeltas := make([]float64, 0, len(pointerOffsetsMs))
		for _, pointerOffsetMs := range pointerOffsetsMs {
			detectedOffsetMs := findClickTransientNearMs(wav, pointerOffsetMs)
			deltaMs := 0.0
			if detectedOffsetMs >= 0 {
				deltaMs = pointerOffsetMs - detectedOffsetMs
				mouseDeltas = append(mouseDeltas, deltaMs)
			}
			response.MouseResults = append(response.MouseResults, MouseResult{
				PointerOffsetMs:  pointerOffsetMs,
				DetectedOffsetMs: detectedOffsetMs,
				DeltaMs:          deltaMs,
			})
		}

		if len(mouseDeltas) > 0 {
			medianMouseDelta, madMouseDelta, rangeMouseDelta := summarizeValues(mouseDeltas)
			response.MouseDeltaMedianMs = medianMouseDelta
			response.MouseDeltaMADMs = madMouseDelta
			response.MouseDeltaRangeMs = rangeMouseDelta
			response.ClickOffsetMs = median(pointerOffsetsMs) - medianMouseDelta
		}

		response.Message = "Acoustic loopback probes and physical mouse presses analyzed"
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return
	}
}

func ReturnRawWav(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	wavID := r.URL.Query().Get("wav_id")
	if wavID == "" {
		http.Error(w, "Missing wav_id parameter", http.StatusBadRequest)
		return
	}

	storeMutex.RLock()
	audioData, exists := wavStore[wavID]
	storeMutex.RUnlock()

	if !exists {
		http.Error(w, "Requested WAV ID not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(audioData)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(audioData)
}