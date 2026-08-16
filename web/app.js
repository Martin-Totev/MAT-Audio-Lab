        const statusBadge = document.getElementById('status-badge');
        const backendVal = document.getElementById('backend-val');
        const heartbeatVal = document.getElementById('heartbeat-val');
        const consoleLog = document.getElementById('console');

        // --- Reaction Speed Tester State ---
        // Both calibration and the later reaction test use POINTER DOWN, not the
        // DOM click event. pointerdown represents the initial physical press and
        // therefore does not include however long the user holds the button down
        // before releasing it.
        let reactionState = 'IDLE'; // 'IDLE' | 'WAITING' | 'READY'
        let reactionTimeoutId = null;
        let startTime = 0;

        function cancelReactionTest() {
            if (reactionTimeoutId !== null) {
                clearTimeout(reactionTimeoutId);
                reactionTimeoutId = null;
            }
            reactionState = 'IDLE';
        }

        function handleReactionPointerDown(event) {
            const btn = document.getElementById('reaction-btn');
            const resultDisplay = document.getElementById('reaction-result');

            if (btn.disabled) return;

            // Avoid synthetic/default activation behavior affecting timing. The
            // measurement is taken at handler entry before any UI work below.
            const pointerArrivalMs = performance.now();
            event.preventDefault();

            if (reactionState === 'IDLE') {
                reactionState = 'WAITING';
                btn.className = 'reaction-btn waiting';
                btn.innerText = 'Wait for Green...';
                resultDisplay.innerText = 'Get ready...';

                const randomDelay = Math.floor(Math.random() * (4500 - 100 + 1)) + 100;

                reactionTimeoutId = setTimeout(() => {
                    reactionTimeoutId = null;
                    reactionState = 'READY';
                    btn.className = 'reaction-btn ready';
                    btn.innerText = 'PRESS NOW!';
                    startTime = performance.now();
                }, randomDelay);

            } else if (reactionState === 'WAITING') {
                cancelReactionTest();
                btn.className = 'reaction-btn idle';
                btn.innerText = 'Start Reaction Test';
                resultDisplay.innerText = 'Too early! Press to try again.';

            } else if (reactionState === 'READY') {
                const rawReactionTime = pointerArrivalMs - startTime;
                const calibratedTime = Math.max(0, Math.round(rawReactionTime - sessionLatencyOffsetMs));
                const correctionText = `${sessionLatencyOffsetMs >= 0 ? '-' : '+'}${Math.abs(sessionLatencyOffsetMs).toFixed(1)}ms`;

                cancelReactionTest();
                btn.className = 'reaction-btn idle';
                btn.innerText = 'Start Reaction Test';

                resultDisplay.innerText = `Reaction Time: ${calibratedTime} ms (Correction: ${correctionText})`;

                const nowUTC = new Date().toISOString().substr(11, 8) + " UTC";
                appendLog(nowUTC, `Reaction result: ${calibratedTime} ms (Raw pointerdown: ${Math.round(rawReactionTime)}ms, Applied Correction: ${correctionText})`);
            }
        }

        // The ordinary reaction test is permanently bound to pointerdown. During
        // Calibration uses a temporary CAPTURE listener on this same button
        // intercepts the event first and prevents this handler from running.
        document.getElementById('reaction-btn').addEventListener('pointerdown', handleReactionPointerDown);

        function appendLog(timeStr, msg) {
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            entry.innerHTML = `<span class="log-time">[${timeStr}]</span> ${msg}`;
            consoleLog.appendChild(entry);
            consoleLog.scrollTop = consoleLog.scrollHeight;
        }

        async function toggleButton(id) {
            const wrapper = document.getElementById(`wrapper-${id}`);
            const isOpen = wrapper.classList.toggle('open');
            
            const nowUTC = new Date().toISOString().substr(11, 8) + " UTC";
            try {
                const response = await fetch(`/api/button${id}`, { method: 'POST' });
                if (response.ok) {
                    const data = await response.json();
                    appendLog(nowUTC, `${data.message} (Panel ${isOpen ? 'Expanded' : 'Collapsed'})`);
                } else {
                    appendLog(nowUTC, `[ERROR] Button ${id} call failed (Status: ${response.status})`);
                }
            } catch (err) {
                appendLog(nowUTC, `[ERROR] Network error reaching /api/button${id}`);
            }
        }

        // --- Reaction Input Calibration ---
        //
        // One microphone recording contains BOTH:
        //   1. one discarded warm-up chirp plus five measured acoustic chirp probes
        //      machine's physical speakers, and
        //   2. three physical mouse presses captured with pointerdown.
        //
        // The probes measure the effective speaker->air->microphone/WAV reference
        // delay for THIS recording. We then add that measured reference delay to
        // (pointerdown - acoustic mouse-click) to estimate the pointer input path.
        //
        // Because the probes and pointerdown share the same estimated WAV sample-zero
        // clock, any constant sample-zero alignment error is present with opposite sign
        // in the two measurements and cancels when they are added.
        let sessionLatencyOffsetMs = 0;

        const AUDIO_PROCESS_BUFFER_SIZE = 1024;
        const CALIBRATION_DURATION_SECONDS = 13;
        const PROBE_COUNT = 5;
        const MOUSE_PRESS_COUNT = 3;
        const MOUSE_PRESS_COOLDOWN_MS = 450;
        const PROBE_DURATION_MS = 15;
        const PROBE_START_HZ = 1800;
        const PROBE_END_HZ = 7000;
        const PROBE_AMPLITUDE = 0.24;
        const WARMUP_PROBE_DELAY_SECONDS = 0.45;
        const WARMUP_TO_FIRST_MEASURED_SECONDS = 0.50;
        const PROBE_INTERVAL_SECONDS = 0.52;

        // Calibration validation limits. A bad acoustic loopback is rejected instead
        // of being allowed to alter all later reaction measurements.
        const MAX_PROBE_MAD_MS = 3.0;
        const MAX_PROBE_RANGE_MS = 8.0;
        const NORMAL_MIN_VALID_PROBES = 4;
        const STRICT_THREE_PROBE_MAX_MAD_MS = 0.20;
        const STRICT_THREE_PROBE_MAX_RANGE_MS = 0.50;
        const STRICT_THREE_PROBE_MIN_CORRELATION = 0.90;
        const MAX_REASONABLE_REACTION_CORRECTION_MS = 250;
        const MIN_REASONABLE_ESTIMATED_POINTER_MS = -15;
        const MAX_MOUSE_DELTA_MAD_MS = 6.0;
        const MAX_MOUSE_DELTA_RANGE_MS = 15.0;

        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

        async function getFreshAudioStreamWithReleaseRetry() {
            const retryDelaysMs = [0, 75, 150, 300];
            let lastError = null;

            const constraints = {
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            };

            for (let i = 0; i < retryDelaysMs.length; i++) {
                if (retryDelaysMs[i] > 0) {
                    await sleep(retryDelaysMs[i]);
                }

                try {
                    return await navigator.mediaDevices.getUserMedia(constraints);
                } catch (err) {
                    lastError = err;
                    const message = String(err && err.message ? err.message : err).toLowerCase();
                    const deviceBusy = err?.name === 'NotReadableError' || message.includes('device in use');
                    if (!deviceBusy || i === retryDelaysMs.length - 1) {
                        throw err;
                    }
                }
            }

            throw lastError || new Error('Unable to open fresh audio input');
        }

        function createCalibrationProbeBuffer(audioCtx) {
            const sampleRate = audioCtx.sampleRate;
            const sampleCount = Math.max(1, Math.round(sampleRate * PROBE_DURATION_MS / 1000));
            const buffer = audioCtx.createBuffer(1, sampleCount, sampleRate);
            const channel = buffer.getChannelData(0);
            const durationSeconds = sampleCount / sampleRate;
            const sweepRate = (PROBE_END_HZ - PROBE_START_HZ) / durationSeconds;

            for (let i = 0; i < sampleCount; i++) {
                const t = i / sampleRate;
                const phase = 2 * Math.PI * (
                    PROBE_START_HZ * t + 0.5 * sweepRate * t * t
                );

                // Hann envelope keeps the probe spectrally clean while preserving
                // a distinctive broadband chirp for matched-filter detection.
                const window = sampleCount > 1
                    ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (sampleCount - 1))
                    : 1;

                channel[i] = Math.sin(phase) * window * PROBE_AMPLITUDE;
            }

            return buffer;
        }

        // Resolve the performance.now()-domain time at which a particular AudioContext
        // frame was rendered by the physical output device. getOutputTimestamp() gives
        // us a mapping between AudioContext time and output-device performance time.
        async function resolvePhysicalOutputPerformanceMs(audioCtx, targetContextTime) {
            if (typeof audioCtx.getOutputTimestamp !== 'function') {
                throw new Error(
                    'This browser does not expose AudioContext.getOutputTimestamp(); reliable physical-speaker calibration is unavailable'
                );
            }

            const deadline = performance.now() + 5000;

            while (performance.now() < deadline) {
                const ts = audioCtx.getOutputTimestamp();
                const contextTime = Number(ts?.contextTime);
                const performanceTime = Number(ts?.performanceTime);

                if (
                    Number.isFinite(contextTime) &&
                    Number.isFinite(performanceTime) &&
                    contextTime > 0 &&
                    performanceTime > 0 &&
                    contextTime >= targetContextTime
                ) {
                    return performanceTime + (targetContextTime - contextTime) * 1000;
                }

                await sleep(5);
            }

            throw new Error('Timed out while mapping an acoustic probe to the physical speaker output clock');
        }

        async function measureClickRegistrationAgainstAudio() {
            const meterFill = document.getElementById('meter-fill');
            const meterStatus = document.getElementById('meter-status');
            const timerLabel = document.getElementById('timer-label');
            const reactionBtn = document.getElementById('reaction-btn');
            const reactionResult = document.getElementById('reaction-result');
            const nowUTC = () => new Date().toISOString().substr(11, 8) + ' UTC';

            let stream = null;
            let audioCtx = null;
            let source = null;
            let recorder = null;
            let silentGain = null;
            let calibrationPointerHandler = null;
            let calibrationReenableTimeoutId = null;
            let pcmSamples = [];
            const probeSources = [];

            let audioTimelineStartMs = null;
            const jsPointerOffsetsMs = [];
            let capturedSamples = 0;
            let targetSamples = 0;

            let resolveRecordingStarted;
            const recordingStartedPromise = new Promise(resolve => {
                resolveRecordingStarted = resolve;
            });

            let resolveRecordingComplete;
            const recordingCompletePromise = new Promise(resolve => {
                resolveRecordingComplete = resolve;
            });

            try {
                stream = await getFreshAudioStreamWithReleaseRetry();

                const audioTrack = stream.getAudioTracks()[0];
                if (!audioTrack) {
                    throw new Error('No audio input track was returned by getUserMedia');
                }

                const trackSettings = typeof audioTrack.getSettings === 'function'
                    ? audioTrack.getSettings()
                    : {};

                appendLog(
                    nowUTC(),
                    `[MIC] Processing settings: echoCancellation=${String(trackSettings.echoCancellation)}, noiseSuppression=${String(trackSettings.noiseSuppression)}, autoGainControl=${String(trackSettings.autoGainControl)}, reportedLatency=${Number.isFinite(Number(trackSettings.latency)) ? (Number(trackSettings.latency) * 1000).toFixed(2) + 'ms' : 'unavailable'} (diagnostic only).`
                );

                if (
                    trackSettings.echoCancellation === true ||
                    trackSettings.noiseSuppression === true ||
                    trackSettings.autoGainControl === true
                ) {
                    appendLog(
                        nowUTC(),
                        '[MIC WARNING] The browser/device kept microphone processing enabled. Probe correlation will self-check the result and reject unstable calibration.'
                    );
                }

                audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
                if (audioCtx.state === 'suspended') {
                    await audioCtx.resume();
                }

                if (typeof audioCtx.getOutputTimestamp !== 'function') {
                    throw new Error(
                        'AudioContext.getOutputTimestamp() is required for physical speaker timing on this calibration path'
                    );
                }

                const sampleRate = audioCtx.sampleRate;
                targetSamples = Math.round(sampleRate * CALIBRATION_DURATION_SECONDS);

                source = audioCtx.createMediaStreamSource(stream);
                recorder = audioCtx.createScriptProcessor(AUDIO_PROCESS_BUFFER_SIZE, 1, 1);
                silentGain = audioCtx.createGain();
                silentGain.gain.value = 0;

                recorder.onaudioprocess = (e) => {
                    if (capturedSamples >= targetSamples) return;

                    const inputData = e.inputBuffer.getChannelData(0);
                    const callbackArrivalMs = performance.now();

                    if (audioTimelineStartMs === null) {
                        const firstBufferDurationMs = (inputData.length / sampleRate) * 1000;
                        audioTimelineStartMs = callbackArrivalMs - firstBufferDurationMs;
                        resolveRecordingStarted();
                    }

                    const samplesRemaining = targetSamples - capturedSamples;
                    const samplesToCopy = Math.min(inputData.length, samplesRemaining);
                    pcmSamples.push(new Float32Array(inputData.slice(0, samplesToCopy)));
                    capturedSamples += samplesToCopy;

                    let sum = 0;
                    for (let i = 0; i < inputData.length; i++) {
                        sum += inputData[i] * inputData[i];
                    }
                    const rms = Math.sqrt(sum / inputData.length);
                    meterFill.style.width = `${Math.min(100, Math.round(rms * 250))}%`;

                    const remainingSamples = Math.max(0, targetSamples - capturedSamples);
                    const remainingSeconds = Math.ceil(remainingSamples / sampleRate);
                    timerLabel.innerText = `00:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;

                    if (capturedSamples >= targetSamples) {
                        resolveRecordingComplete();
                    }
                };

                source.connect(recorder);
                recorder.connect(silentGain);
                silentGain.connect(audioCtx.destination);

                meterStatus.innerText = 'STARTING ACOUSTIC LOOPBACK...';
                timerLabel.innerText = `00:${String(CALIBRATION_DURATION_SECONDS).padStart(2, '0')}`;
                reactionBtn.disabled = true;
                reactionBtn.className = 'reaction-btn waiting';
                reactionBtn.innerText = 'LISTEN FOR CALIBRATION PROBES...';
                reactionResult.innerText = 'Keep speakers audible and the room reasonably quiet.';

                await recordingStartedPromise;

                // Give the output graph time to begin producing non-zero output timestamps.
                await sleep(50);

                const probeBuffer = createCalibrationProbeBuffer(audioCtx);

                // First play one identical probe only to wake/settle the physical
                // output path. It is deliberately NOT included in the loopback
                // statistics or sent to Go as a measured probe.
                const warmupProbeContextTime = audioCtx.currentTime + WARMUP_PROBE_DELAY_SECONDS;
                const warmupSource = audioCtx.createBufferSource();
                warmupSource.buffer = probeBuffer;
                warmupSource.connect(audioCtx.destination);
                warmupSource.start(warmupProbeContextTime);
                probeSources.push(warmupSource);

                const firstProbeContextTime = warmupProbeContextTime + WARMUP_TO_FIRST_MEASURED_SECONDS;
                const probeContextTimes = [];

                for (let i = 0; i < PROBE_COUNT; i++) {
                    const probeTime = firstProbeContextTime + i * PROBE_INTERVAL_SECONDS;
                    probeContextTimes.push(probeTime);

                    const probeSource = audioCtx.createBufferSource();
                    probeSource.buffer = probeBuffer;
                    probeSource.connect(audioCtx.destination);
                    probeSource.start(probeTime);
                    probeSources.push(probeSource);
                }

                appendLog(
                    nowUTC(),
                    `[LOOPBACK] Scheduled 1 discarded warm-up probe + ${PROBE_COUNT} measured probes (${PROBE_DURATION_MS}ms, ${PROBE_START_HZ}-${PROBE_END_HZ}Hz). Do not click until the button changes.`
                );

                const warmupPhysicalOutputMs = await resolvePhysicalOutputPerformanceMs(
                    audioCtx,
                    warmupProbeContextTime
                );
                const warmupExpectedOffsetMs = warmupPhysicalOutputMs - audioTimelineStartMs;
                appendLog(
                    nowUTC(),
                    `[LOOPBACK] Warm-up probe rendered at WAV-clock +${warmupExpectedOffsetMs.toFixed(2)}ms and will be discarded from calibration statistics.`
                );

                const expectedProbeOffsetsMs = [];

                for (let i = 0; i < probeContextTimes.length; i++) {
                    const physicalOutputPerformanceMs = await resolvePhysicalOutputPerformanceMs(
                        audioCtx,
                        probeContextTimes[i]
                    );
                    const expectedOffsetMs = physicalOutputPerformanceMs - audioTimelineStartMs;
                    expectedProbeOffsetsMs.push(expectedOffsetMs);

                    appendLog(
                        nowUTC(),
                        `[LOOPBACK] Probe ${i + 1}/${PROBE_COUNT} physically rendered at expected WAV-clock +${expectedOffsetMs.toFixed(2)}ms.`
                    );
                }

                // Let the final short probe decay before accepting the mouse press.
                await sleep(180);

                cancelReactionTest();
                reactionBtn.disabled = false;
                reactionBtn.className = 'reaction-btn ready';
                reactionBtn.innerText = `CALIBRATE — PRESS 1 OF ${MOUSE_PRESS_COUNT}`;
                reactionResult.innerText = `Press this button ${MOUSE_PRESS_COUNT} times, about half a second apart.`;
                meterStatus.innerText = `PROBES CAPTURED — ${MOUSE_PRESS_COUNT} CALIBRATION PRESSES NEEDED`;

                calibrationPointerHandler = (event) => {
                    const pointerArrivalMs = performance.now();

                    event.preventDefault();
                    event.stopImmediatePropagation();

                    if (jsPointerOffsetsMs.length >= MOUSE_PRESS_COUNT) {
                        return;
                    }

                    const pointerOffsetMs = pointerArrivalMs - audioTimelineStartMs;
                    jsPointerOffsetsMs.push(pointerOffsetMs);
                    const pressNumber = jsPointerOffsetsMs.length;

                    appendLog(
                        nowUTC(),
                        `[POINTER-JS] Calibration press ${pressNumber}/${MOUSE_PRESS_COUNT} registered at +${pointerOffsetMs.toFixed(2)}ms on the shared WAV clock.`
                    );

                    reactionBtn.disabled = true;
                    reactionBtn.className = 'reaction-btn waiting';

                    if (pressNumber >= MOUSE_PRESS_COUNT) {
                        reactionBtn.innerText = `${MOUSE_PRESS_COUNT}/${MOUSE_PRESS_COUNT} PRESSES CAPTURED`;
                        reactionResult.innerText = 'All mouse presses captured. Keep still while recording finishes...';
                        meterStatus.innerText = 'MOUSE PRESSES CAPTURED — FINISHING RECORDING';
                        return;
                    }

                    reactionBtn.innerText = `PRESS ${pressNumber + 1} OF ${MOUSE_PRESS_COUNT} — WAIT...`;
                    reactionResult.innerText = `Captured ${pressNumber}/${MOUSE_PRESS_COUNT}. Press again when the button turns green.`;

                    calibrationReenableTimeoutId = setTimeout(() => {
                        calibrationReenableTimeoutId = null;
                        if (jsPointerOffsetsMs.length < MOUSE_PRESS_COUNT) {
                            reactionBtn.disabled = false;
                            reactionBtn.className = 'reaction-btn ready';
                            reactionBtn.innerText = `CALIBRATE — PRESS ${jsPointerOffsetsMs.length + 1} OF ${MOUSE_PRESS_COUNT}`;
                        }
                    }, MOUSE_PRESS_COOLDOWN_MS);
                };

                reactionBtn.addEventListener('pointerdown', calibrationPointerHandler, true);

                appendLog(
                    nowUTC(),
                    `[CALIB] Loopback probes complete. Press the calibration button ${MOUSE_PRESS_COUNT} times, about ${MOUSE_PRESS_COOLDOWN_MS}ms or more apart; recording remains on the same ${sampleRate}Hz stream.`
                );

                await recordingCompletePromise;
                timerLabel.innerText = '00:00';

                if (calibrationPointerHandler) {
                    reactionBtn.removeEventListener('pointerdown', calibrationPointerHandler, true);
                    calibrationPointerHandler = null;
                }
                if (calibrationReenableTimeoutId !== null) {
                    clearTimeout(calibrationReenableTimeoutId);
                    calibrationReenableTimeoutId = null;
                }

                reactionBtn.disabled = true;
                reactionBtn.className = 'reaction-btn waiting';
                reactionBtn.innerText = 'CALIBRATION PROCESSING...';

                if (jsPointerOffsetsMs.length !== MOUSE_PRESS_COUNT) {
                    throw new Error(`Calibration needs exactly ${MOUSE_PRESS_COUNT} mouse presses; captured ${jsPointerOffsetsMs.length}. Please retry and follow the ? instructions.`);
                }

                if (source) {
                    try { source.disconnect(); } catch (_) {}
                    source = null;
                }
                if (recorder) {
                    try { recorder.disconnect(); } catch (_) {}
                    recorder.onaudioprocess = null;
                    recorder = null;
                }
                if (silentGain) {
                    try { silentGain.disconnect(); } catch (_) {}
                    silentGain = null;
                }
                if (stream) {
                    stream.getTracks().forEach(track => {
                        try { track.stop(); } catch (_) {}
                    });
                    stream = null;
                }

                meterFill.style.width = '0%';
                meterStatus.innerText = 'Analyzing loopback + 3 mouse presses...';

                const mergedPCM = new Float32Array(targetSamples);
                let offset = 0;
                for (const chunk of pcmSamples) {
                    mergedPCM.set(chunk, offset);
                    offset += chunk.length;
                }

                const wavBuffer = encodeWAV(mergedPCM, sampleRate);
                const formData = new FormData();
                formData.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'measurement.wav');
                formData.append('mode', 'measurement');
                formData.append('pointer_offsets_ms', JSON.stringify(jsPointerOffsetsMs));
                formData.append('probe_expected_offsets_ms', JSON.stringify(expectedProbeOffsetsMs));

                appendLog(
                    nowUTC(),
                    '[DSP] Sending one WAV to Go for matched-filter probe detection and 3 local mouse-press detections...'
                );

                const uploadRes = await fetch('/api/audio-upload', {
                    method: 'POST',
                    body: formData
                });

                const responseText = await uploadRes.text();
                if (!uploadRes.ok) {
                    throw new Error(responseText || `DSP request failed with HTTP ${uploadRes.status}`);
                }

                let data;
                try {
                    data = JSON.parse(responseText);
                } catch (_) {
                    throw new Error('Go returned a non-JSON calibration response');
                }

                const probeResults = Array.isArray(data.probe_results) ? data.probe_results : [];
                const validProbeResults = probeResults.filter(result =>
                    result.accepted === true &&
                    Number.isFinite(Number(result.detected_offset_ms)) &&
                    Number(result.detected_offset_ms) >= 0 &&
                    Number.isFinite(Number(result.delay_ms)) &&
                    Number.isFinite(Number(result.correlation))
                );

                for (let i = 0; i < probeResults.length; i++) {
                    const result = probeResults[i];
                    const detected = Number(result.detected_offset_ms);
                    const delay = Number(result.delay_ms);
                    const correlation = Number(result.correlation);

                    if (Number.isFinite(detected) && detected >= 0) {
                        appendLog(
                            nowUTC(),
                            `[LOOPBACK DSP] Probe ${i + 1}: detected +${detected.toFixed(2)}ms, effective delay ${delay.toFixed(2)}ms, correlation ${correlation.toFixed(3)} — ${result.accepted === true ? 'ACCEPTED' : 'REJECTED AS OUTLIER'}.`
                        );
                    } else {
                        appendLog(nowUTC(), `[LOOPBACK DSP] Probe ${i + 1}: NOT reliably detected.`);
                    }
                }

                const effectiveAudioReferenceDelayMs = Number(data.probe_delay_median_ms);
                const probeMadMs = Number(data.probe_delay_mad_ms);
                const probeRangeMs = Number(data.probe_delay_range_ms);

                const strictThreeProbeFallback =
                    validProbeResults.length === 3 &&
                    Number.isFinite(probeMadMs) &&
                    Number.isFinite(probeRangeMs) &&
                    probeMadMs <= STRICT_THREE_PROBE_MAX_MAD_MS &&
                    probeRangeMs <= STRICT_THREE_PROBE_MAX_RANGE_MS &&
                    validProbeResults.every(result =>
                        Number(result.correlation) >= STRICT_THREE_PROBE_MIN_CORRELATION
                    );

                const probeCountAccepted =
                    validProbeResults.length >= NORMAL_MIN_VALID_PROBES ||
                    strictThreeProbeFallback;

                if (
                    !probeCountAccepted ||
                    !Number.isFinite(effectiveAudioReferenceDelayMs) ||
                    !Number.isFinite(probeMadMs) ||
                    !Number.isFinite(probeRangeMs)
                ) {
                    throw new Error(
                        `Acoustic loopback was not reliable enough (${validProbeResults.length}/${PROBE_COUNT} probes accepted). Check speaker volume, microphone selection, and room noise.`
                    );
                }

                if (strictThreeProbeFallback) {
                    appendLog(
                        nowUTC(),
                        `[LOOPBACK] Using strict 3/5 fallback: the three accepted probes form a very tight cluster (MAD ${probeMadMs.toFixed(2)}ms, range ${probeRangeMs.toFixed(2)}ms, all correlation ≥ ${STRICT_THREE_PROBE_MIN_CORRELATION.toFixed(2)}).`
                    );
                }

                appendLog(
                    nowUTC(),
                    `[LOOPBACK] Effective audio reference delay = ${effectiveAudioReferenceDelayMs.toFixed(2)}ms; MAD ${probeMadMs.toFixed(2)}ms; range ${probeRangeMs.toFixed(2)}ms (${validProbeResults.length}/${PROBE_COUNT} probes).`
                );

                if (probeMadMs > MAX_PROBE_MAD_MS || probeRangeMs > MAX_PROBE_RANGE_MS) {
                    throw new Error(
                        `Acoustic loopback was unstable (MAD ${probeMadMs.toFixed(2)}ms, range ${probeRangeMs.toFixed(2)}ms). No reaction correction was applied.`
                    );
                }

                const mouseResults = Array.isArray(data.mouse_results) ? data.mouse_results : [];
                if (mouseResults.length !== MOUSE_PRESS_COUNT) {
                    throw new Error(`Go returned ${mouseResults.length}/${MOUSE_PRESS_COUNT} mouse measurements; calibration was not applied.`);
                }

                const validMouseResults = mouseResults.filter(result =>
                    Number.isFinite(Number(result.pointer_offset_ms)) &&
                    Number.isFinite(Number(result.detected_offset_ms)) &&
                    Number(result.detected_offset_ms) >= 0 &&
                    Number.isFinite(Number(result.delta_ms))
                );

                for (let i = 0; i < mouseResults.length; i++) {
                    const result = mouseResults[i];
                    const pointerOffset = Number(result.pointer_offset_ms);
                    const detectedOffset = Number(result.detected_offset_ms);
                    const delta = Number(result.delta_ms);

                    if (Number.isFinite(detectedOffset) && detectedOffset >= 0) {
                        appendLog(
                            nowUTC(),
                            `[MOUSE DSP] Press ${i + 1}/${MOUSE_PRESS_COUNT}: pointer +${pointerOffset.toFixed(2)}ms, acoustic +${detectedOffset.toFixed(2)}ms, mouse-vs-audio delta ${delta.toFixed(2)}ms.`
                        );
                    } else {
                        appendLog(nowUTC(), `[MOUSE DSP] Press ${i + 1}/${MOUSE_PRESS_COUNT}: physical transient NOT reliably detected.`);
                    }
                }

                if (validMouseResults.length !== MOUSE_PRESS_COUNT) {
                    throw new Error(`Only ${validMouseResults.length}/${MOUSE_PRESS_COUNT} mouse presses were detected in the audio. Please retry in a quieter room or click more firmly.`);
                }

                const observedMouseVsAudioDeltaMs = Number(data.mouse_delta_median_ms);
                const mouseDeltaMadMs = Number(data.mouse_delta_mad_ms);
                const mouseDeltaRangeMs = Number(data.mouse_delta_range_ms);

                if (
                    !Number.isFinite(observedMouseVsAudioDeltaMs) ||
                    !Number.isFinite(mouseDeltaMadMs) ||
                    !Number.isFinite(mouseDeltaRangeMs)
                ) {
                    throw new Error('Go did not return valid 3-press mouse statistics');
                }

                appendLog(
                    nowUTC(),
                    `[MOUSE] Median mouse-vs-audio delta = ${observedMouseVsAudioDeltaMs.toFixed(2)}ms; MAD ${mouseDeltaMadMs.toFixed(2)}ms; range ${mouseDeltaRangeMs.toFixed(2)}ms.`
                );

                if (mouseDeltaMadMs > MAX_MOUSE_DELTA_MAD_MS || mouseDeltaRangeMs > MAX_MOUSE_DELTA_RANGE_MS) {
                    throw new Error(
                        `Mouse calibration was inconsistent (MAD ${mouseDeltaMadMs.toFixed(2)}ms, range ${mouseDeltaRangeMs.toFixed(2)}ms). No reaction correction was applied.`
                    );
                }

                const estimatedPointerLatencyMs = observedMouseVsAudioDeltaMs + effectiveAudioReferenceDelayMs;

                appendLog(
                    nowUTC(),
                    `[CALIB] Estimated pointer latency = median mouse delta ${observedMouseVsAudioDeltaMs.toFixed(2)} + measured audio reference ${effectiveAudioReferenceDelayMs.toFixed(2)} = ${estimatedPointerLatencyMs.toFixed(2)}ms.`
                );

                if (
                    estimatedPointerLatencyMs < MIN_REASONABLE_ESTIMATED_POINTER_MS ||
                    Math.abs(estimatedPointerLatencyMs) > MAX_REASONABLE_REACTION_CORRECTION_MS
                ) {
                    throw new Error(
                        `Calibration produced an implausible estimated pointer latency (${estimatedPointerLatencyMs.toFixed(2)}ms); no session correction was applied`
                    );
                }

                const reactionCorrectionMs = Math.max(0, estimatedPointerLatencyMs);

                if (estimatedPointerLatencyMs < 0) {
                    appendLog(
                        nowUTC(),
                        `[CALIB] Estimate is slightly negative (${estimatedPointerLatencyMs.toFixed(2)}ms), consistent with small speaker/mouse acoustic-distance differences; applied correction is clamped to 0.00ms.`
                    );
                }

                appendLog(
                    nowUTC(),
                    `[SESSION] Reaction correction = ${reactionCorrectionMs.toFixed(2)}ms.`
                );

                return {
                    correctionMs: reactionCorrectionMs,
                    observedMouseVsAudioDeltaMs,
                    effectiveAudioReferenceDelayMs,
                    probeMadMs,
                    probeRangeMs,
                    validProbeCount: validProbeResults.length,
                    mouseDeltaMadMs,
                    mouseDeltaRangeMs,
                    estimatedPointerLatencyMs
                };
            } finally {
                if (calibrationPointerHandler) {
                    const btn = document.getElementById('reaction-btn');
                    btn.removeEventListener('pointerdown', calibrationPointerHandler, true);
                    calibrationPointerHandler = null;
                }
                if (calibrationReenableTimeoutId !== null) {
                    clearTimeout(calibrationReenableTimeoutId);
                    calibrationReenableTimeoutId = null;
                }

                for (const probeSource of probeSources) {
                    try { probeSource.stop(); } catch (_) {}
                    try { probeSource.disconnect(); } catch (_) {}
                }

                if (source) {
                    try { source.disconnect(); } catch (_) {}
                }
                if (recorder) {
                    try { recorder.disconnect(); } catch (_) {}
                    recorder.onaudioprocess = null;
                }
                if (silentGain) {
                    try { silentGain.disconnect(); } catch (_) {}
                }
                if (stream) {
                    stream.getTracks().forEach(track => {
                        try { track.stop(); } catch (_) {}
                    });
                }
                if (audioCtx) {
                    try { await audioCtx.close(); } catch (_) {}
                }

                pcmSamples = [];
                meterFill.style.width = '0%';
                meterStatus.innerText = 'Input Level';
                timerLabel.innerText = `00:${String(CALIBRATION_DURATION_SECONDS).padStart(2, '0')}`;
                appendLog(nowUTC(), '[CALIB] Acoustic calibration audio objects destroyed.');
            }
        }

        async function streamAudioToGo() {
            const captureBtn = document.getElementById('capture-btn');
            const meterStatus = document.getElementById('meter-status');
            const reactionBtn = document.getElementById('reaction-btn');
            const reactionResult = document.getElementById('reaction-result');
            const nowUTC = () => new Date().toISOString().substr(11, 8) + ' UTC';

            if (captureBtn.disabled) return;

            cancelReactionTest();
            captureBtn.disabled = true;
            reactionBtn.disabled = true;
            reactionBtn.className = 'reaction-btn waiting';
            reactionBtn.innerText = 'PREPARING LOOPBACK...';
            reactionResult.innerText = 'Keep laptop/external speakers audible. Do not use headphones.';
            meterStatus.innerText = 'Preparing Acoustic Calibration...';

            try {
                const calibration = await measureClickRegistrationAgainstAudio();

                sessionLatencyOffsetMs = calibration.correctionMs;
                reactionResult.innerText = `Calibration locked: ${sessionLatencyOffsetMs.toFixed(2)} ms correction`;
                appendLog(
                    nowUTC(),
                    `[SESSION LOCKED] Correction ${sessionLatencyOffsetMs.toFixed(2)}ms = median mouse-vs-audio ${calibration.observedMouseVsAudioDeltaMs.toFixed(2)}ms + measured loopback ${calibration.effectiveAudioReferenceDelayMs.toFixed(2)}ms. Mouse MAD ${calibration.mouseDeltaMadMs.toFixed(2)}ms, range ${calibration.mouseDeltaRangeMs.toFixed(2)}ms. Probe MAD ${calibration.probeMadMs.toFixed(2)}ms, range ${calibration.probeRangeMs.toFixed(2)}ms.`
                );
            } catch (err) {
                reactionResult.innerText = `Calibration failed: ${err.message}`;
                appendLog(nowUTC(), `[CALIBRATION ERROR] ${err.message}`);
            } finally {
                cancelReactionTest();
                captureBtn.disabled = false;
                reactionBtn.disabled = false;
                reactionBtn.className = 'reaction-btn idle';
                reactionBtn.innerText = 'Start Reaction Test';
                meterStatus.innerText = 'Input Level';
            }
        }

        // Creates standard 32-bit Float IEEE WAV binary payload
        function encodeWAV(samples, sampleRate) {
            const buffer = new ArrayBuffer(44 + samples.length * 4);
            const view = new DataView(buffer);

            writeString(view, 0, 'RIFF');
            view.setUint32(4, 36 + samples.length * 4, true);
            writeString(view, 8, 'WAVE');
            writeString(view, 12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 3, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 4, true);
            view.setUint16(32, 4, true);
            view.setUint16(34, 32, true);
            writeString(view, 36, 'data');
            view.setUint32(40, samples.length * 4, true);

            let offset = 44;
            for (let i = 0; i < samples.length; i++, offset += 4) {
                view.setFloat32(offset, samples[i], true);
            }

            return buffer;
        }

        function writeString(view, offset, string) {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        }

        async function checkEngineStatus() {
            try {
                fetch('/api/presence', { method: 'POST' }).catch(() => {});

                const response = await fetch('/api/status');
                if (response.ok) {
                    const data = await response.json();
                    if (statusBadge.classList.contains('offline')) {
                        statusBadge.className = 'badge online';
                        statusBadge.innerText = 'CONNECTED';
                        appendLog(data.time, 'Connected to MAT Audio Lab core engine.');
                    }
                    backendVal.innerText = data.environment;
                    heartbeatVal.innerText = `${data.time} UTC`;
                } else {
                    throw new Error('Non-200 status');
                }
            } catch (err) {
                if (statusBadge.classList.contains('online')) {
                    const nowUTC = new Date().toISOString().substr(11, 8);
                    appendLog(`${nowUTC} UTC`, 'Lost connection to backend engine.');
                }
                statusBadge.className = 'badge offline';
                statusBadge.innerText = 'DISCONNECTED';
                backendVal.innerText = 'Offline Static Mode';
                heartbeatVal.innerText = '--:--:-- UTC';
            }
        }

        setInterval(checkEngineStatus, 1000);
        checkEngineStatus();
