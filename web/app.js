        const statusBadge = document.getElementById('status-badge');
        const backendVal = document.getElementById('backend-val');
        const heartbeatVal = document.getElementById('heartbeat-val');
        const consoleLog = document.getElementById('console');
        const engineLogs = [];
        const browserTabId = window.crypto && typeof window.crypto.randomUUID === 'function'
            ? window.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const browserPresenceQuery = `tab_id=${encodeURIComponent(browserTabId)}`;

        window.addEventListener('pagehide', () => {
            navigator.sendBeacon(`/api/presence/close?${browserPresenceQuery}`);
        });

        // --- Reaction Speed Tester State ---
        // Both the reaction test and the standalone calibration press control use
        // POINTER DOWN, not the DOM click event. pointerdown represents the initial
        // physical press and therefore does not include however long the user holds
        // the button down before releasing it.
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
            const btn = document.getElementById('reaction-test-btn');
            const resultDisplay = document.getElementById('reaction-test-result');

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

        // The ordinary reaction test is permanently bound to its own button.
        // Calibration uses a separate temporary pointerdown listener below.
        document.getElementById('reaction-test-btn').addEventListener('pointerdown', handleReactionPointerDown);

        function appendLog(timeStr, msg, occurredAt = new Date()) {
            const log = {
                timestampMs: occurredAt.getTime(),
                timeLabel: String(timeStr),
                message: String(msg)
            };
            engineLogs.push(log);

            const entry = document.createElement('div');
            entry.className = 'log-entry';
            const time = document.createElement('span');
            time.className = 'log-time';
            time.textContent = `[${log.timeLabel}]`;
            entry.append(time, document.createTextNode(` ${log.message}`));
            consoleLog.appendChild(entry);
            consoleLog.scrollTop = consoleLog.scrollHeight;
        }

        async function writeLogTextToClipboard(text) {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return;
            }

            const fallback = document.createElement('textarea');
            fallback.value = text;
            fallback.setAttribute('readonly', '');
            fallback.style.position = 'fixed';
            fallback.style.opacity = '0';
            document.body.appendChild(fallback);
            fallback.select();
            const copied = document.execCommand('copy');
            fallback.remove();
            if (!copied) {
                throw new Error('Clipboard access was denied');
            }
        }

        async function copyEngineLogs() {
            const button = document.getElementById('copy-logs-btn');
            const fromValue = document.getElementById('log-copy-from').value;
            const throughValue = document.getElementById('log-copy-through').value;
            const status = document.getElementById('log-copy-status');
            const fromMs = fromValue ? new Date(fromValue).getTime() : null;
            const throughMs = throughValue ? new Date(throughValue).getTime() : null;

            status.className = 'log-copy-status';
            if ((fromMs !== null && !Number.isFinite(fromMs)) ||
                (throughMs !== null && !Number.isFinite(throughMs))) {
                status.classList.add('error');
                status.textContent = 'Enter valid local date and time bounds.';
                return;
            }
            if (fromMs !== null && throughMs !== null && fromMs > throughMs) {
                status.classList.add('error');
                status.textContent = 'The From bound must not be later than Through.';
                return;
            }

            const selectedLogs = engineLogs.filter((log) =>
                (fromMs === null || log.timestampMs >= fromMs) &&
                (throughMs === null || log.timestampMs <= throughMs)
            );
            if (selectedLogs.length === 0) {
                status.textContent = 'No log entries fall within those bounds.';
                return;
            }

            button.disabled = true;
            try {
                const text = selectedLogs
                    .map((log) => `[${log.timeLabel}] ${log.message}`)
                    .join('\n');
                await writeLogTextToClipboard(text);
                const noun = selectedLogs.length === 1 ? 'entry' : 'entries';
                status.textContent = `Copied ${selectedLogs.length} log ${noun}.`;
            } catch (error) {
                status.classList.add('error');
                status.textContent = `Could not copy logs: ${error.message}`;
            } finally {
                button.disabled = false;
            }
        }

        document.getElementById('copy-logs-btn').addEventListener('click', copyEngineLogs);
        appendLog('LOCAL', 'UI loaded in standalone editing mode.');

        // --- Metronome Timing Test ---
        // The selected duration applies to the silent portion. Before scoring begins,
        // the beat is fully audible for five seconds and fades linearly for three.
        const METRONOME_FULL_VOLUME_SECONDS = 5;
        const METRONOME_FADE_SECONDS = 3;
        const METRONOME_MIN_BPM = 50;
        const METRONOME_MAX_BPM = 180;
        const METRONOME_ALLOWED_DURATIONS = [10, 30, 60];

        let selectedMetronomeDurationSeconds = 10;
        let metronomeState = 'IDLE'; // 'IDLE' | 'STARTING' | 'RUNNING'
        let metronomeRun = null;
        let metronomeUiIntervalId = null;
        let metronomeFinishTimeoutId = null;
        let metronomeRunToken = 0;

        function formatMetronomeTime(remainingMs) {
            const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }

        function getMetronomeDurationButtons() {
            return Array.from(document.querySelectorAll('.metronome-duration-btn'));
        }

        function setMetronomeDuration(seconds) {
            if (metronomeState !== 'IDLE' || !METRONOME_ALLOWED_DURATIONS.includes(seconds)) {
                return;
            }

            selectedMetronomeDurationSeconds = seconds;
            getMetronomeDurationButtons().forEach((button) => {
                const selected = Number(button.dataset.duration) === seconds;
                button.classList.toggle('selected', selected);
                button.setAttribute('aria-pressed', String(selected));
            });
            document.getElementById('metronome-timer').textContent =
                formatMetronomeTime(seconds * 1000);
        }

        function setMetronomeControlsLocked(locked) {
            getMetronomeDurationButtons().forEach((button) => {
                button.disabled = locked;
            });
            document.getElementById('metronome-start-btn').disabled = locked;
        }

        function mapMetronomeAudioTimeToPerformanceMs(audioCtx, targetContextTime) {
            if (typeof audioCtx.getOutputTimestamp === 'function') {
                const timestamp = audioCtx.getOutputTimestamp();
                const contextTime = Number(timestamp?.contextTime);
                const performanceTime = Number(timestamp?.performanceTime);
                if (
                    Number.isFinite(contextTime) &&
                    Number.isFinite(performanceTime) &&
                    contextTime >= 0 &&
                    performanceTime > 0
                ) {
                    return performanceTime + (targetContextTime - contextTime) * 1000;
                }
            }

            // Fall back to the browser's estimated physical output latency when a
            // direct AudioContext/performance clock mapping is unavailable.
            const reportedOutputLatency = Number(audioCtx.outputLatency);
            const reportedBaseLatency = Number(audioCtx.baseLatency);
            const outputLatencySeconds = Number.isFinite(reportedOutputLatency) && reportedOutputLatency >= 0
                ? reportedOutputLatency
                : (Number.isFinite(reportedBaseLatency) && reportedBaseLatency >= 0
                    ? reportedBaseLatency
                    : 0);

            return performance.now() +
                (targetContextTime - audioCtx.currentTime + outputLatencySeconds) * 1000;
        }

        function scheduleMetronomeClick(audioCtx, destination, contextTime, beatIndex) {
            const oscillator = audioCtx.createOscillator();
            const clickGain = audioCtx.createGain();

            oscillator.type = 'square';
            oscillator.frequency.setValueAtTime(beatIndex % 4 === 0 ? 1320 : 940, contextTime);
            clickGain.gain.setValueAtTime(0.0001, contextTime);
            clickGain.gain.exponentialRampToValueAtTime(0.72, contextTime + 0.003);
            clickGain.gain.exponentialRampToValueAtTime(0.0001, contextTime + 0.045);

            oscillator.connect(clickGain);
            clickGain.connect(destination);
            oscillator.start(contextTime);
            oscillator.stop(contextTime + 0.05);
        }

        function clearMetronomeTimers() {
            if (metronomeUiIntervalId !== null) {
                clearInterval(metronomeUiIntervalId);
                metronomeUiIntervalId = null;
            }
            if (metronomeFinishTimeoutId !== null) {
                clearTimeout(metronomeFinishTimeoutId);
                metronomeFinishTimeoutId = null;
            }
        }

        function closeMetronomeAudio(run) {
            if (!run) return;

            try {
                run.masterGain.gain.cancelScheduledValues(run.audioContext.currentTime);
                run.masterGain.gain.setValueAtTime(0, run.audioContext.currentTime);
            } catch (_) {
                // The context may already have been closed.
            }
            Promise.resolve(run.audioContext.close()).catch(() => {});
        }

        function resetMetronomeControls() {
            setMetronomeControlsLocked(false);
            const tapButton = document.getElementById('metronome-tap-btn');
            tapButton.disabled = true;
            tapButton.className = 'metronome-tap-btn';
            tapButton.textContent = 'Tap the Beat';
        }

        function summarizeMetronomeRun(run) {
            const absoluteErrors = Array.from(run.taps.values(), (tap) => Math.abs(tap.errorMs));
            const hitCount = absoluteErrors.length;
            const expectedCount = Math.max(0, run.lastExpectedBeatIndex - run.firstExpectedBeatIndex + 1);
            const missedCount = Math.max(0, expectedCount - hitCount);
            const meanAbsoluteErrorMs = hitCount > 0
                ? absoluteErrors.reduce((sum, error) => sum + error, 0) / hitCount
                : null;

            return {
                hitCount,
                expectedCount,
                missedCount,
                meanAbsoluteErrorMs
            };
        }

        function clearMetronomeTimeline() {
            const timeline = document.getElementById('metronome-timeline');
            timeline.hidden = true;
            timeline.classList.remove('revealed');
            document.getElementById('metronome-expected-track').replaceChildren();
            document.getElementById('metronome-actual-track').replaceChildren();
            document.getElementById('wrapper-2').classList.remove('timeline-visible');
        }

        function addMetronomeTimelineMarker(track, percent, className, label) {
            const marker = document.createElement('span');
            marker.className = `metronome-timeline-marker ${className}`;
            marker.style.left = `${Math.min(100, Math.max(0, percent))}%`;
            marker.title = label;
            marker.setAttribute('role', 'img');
            marker.setAttribute('aria-label', label);
            track.appendChild(marker);
        }

        function renderMetronomeTimeline(run) {
            clearMetronomeTimeline();

            const expectedTrack = document.getElementById('metronome-expected-track');
            const actualTrack = document.getElementById('metronome-actual-track');
            const durationMs = run.durationSeconds * 1000;

            for (
                let beatIndex = run.firstExpectedBeatIndex;
                beatIndex <= run.lastExpectedBeatIndex;
                beatIndex += 1
            ) {
                const expectedPerformanceMs =
                    run.beatOriginPerformanceMs + beatIndex * run.beatIntervalMs;
                const offsetMs = expectedPerformanceMs - run.silentStartPerformanceMs;
                const percent = offsetMs / durationMs * 100;
                addMetronomeTimelineMarker(
                    expectedTrack,
                    percent,
                    'expected',
                    `Expected beat at ${(offsetMs / 1000).toFixed(2)}s`
                );
            }

            const actualTaps = Array.isArray(run.actualTaps)
                ? run.actualTaps
                : Array.from(run.taps.values());
            const sortedTaps = Array.from(actualTaps).sort(
                (left, right) =>
                    left.correctedTapPerformanceMs - right.correctedTapPerformanceMs
            );
            sortedTaps.forEach((tap) => {
                const offsetMs =
                    tap.correctedTapPerformanceMs - run.silentStartPerformanceMs;
                const percent = offsetMs / durationMs * 100;
                const absoluteErrorMs = Math.abs(tap.errorMs);
                const direction = tap.errorMs < 0 ? 'early' : 'late';
                const accuracyClass = absoluteErrorMs > 50 ? 'actual off-beat' : 'actual';
                addMetronomeTimelineMarker(
                    actualTrack,
                    percent,
                    accuracyClass,
                    `Actual tap at ${(offsetMs / 1000).toFixed(2)}s · ${absoluteErrorMs.toFixed(1)}ms ${direction}`
                );
            });

            document.getElementById('metronome-timeline-end').textContent =
                `${run.durationSeconds}s`;
            const timeline = document.getElementById('metronome-timeline');
            timeline.hidden = false;
            timeline.classList.remove('revealed');
            void timeline.offsetWidth;
            timeline.classList.add('revealed');
            document.getElementById('wrapper-2').classList.add('timeline-visible');
        }

        function finishMetronomeTest() {
            if (metronomeState !== 'RUNNING' || !metronomeRun) return;

            const run = metronomeRun;
            const summary = summarizeMetronomeRun(run);
            const result = document.getElementById('metronome-result');
            const status = document.getElementById('metronome-status');
            const startButton = document.getElementById('metronome-start-btn');

            clearMetronomeTimers();
            metronomeState = 'IDLE';
            metronomeRun = null;
            resetMetronomeControls();
            document.getElementById('metronome-progress').style.width = '100%';
            document.getElementById('metronome-timer').textContent = '00:00';
            startButton.textContent = 'Run Metronome Test Again';

            if (summary.meanAbsoluteErrorMs === null) {
                result.textContent = 'No scored taps recorded';
                status.textContent =
                    `0/${summary.expectedCount} expected silent beats captured at ${run.bpm} BPM.`;
                appendLog(
                    new Date().toISOString().substr(11, 8) + ' UTC',
                    `[METRONOME] ${run.durationSeconds}s silent test at ${run.bpm} BPM finished without scored taps.`
                );
            } else {
                result.textContent =
                    `Average distance: ${summary.meanAbsoluteErrorMs.toFixed(1)} ms`;
                status.textContent =
                    `${summary.hitCount}/${summary.expectedCount} expected beats captured · ${summary.missedCount} missed · ${run.bpm} BPM`;
                appendLog(
                    new Date().toISOString().substr(11, 8) + ' UTC',
                    `[METRONOME] ${run.durationSeconds}s silent test at ${run.bpm} BPM: mean absolute error ${summary.meanAbsoluteErrorMs.toFixed(2)}ms across ${summary.hitCount}/${summary.expectedCount} expected beats; ${summary.missedCount} missed.`
                );
            }

            renderMetronomeTimeline(run);
            closeMetronomeAudio(run);
        }

        function cancelMetronomeTest() {
            if (metronomeState === 'IDLE') return;

            metronomeRunToken += 1;
            const run = metronomeRun;
            clearMetronomeTimers();
            metronomeState = 'IDLE';
            metronomeRun = null;
            resetMetronomeControls();
            document.getElementById('metronome-bpm').textContent = '-- BPM';
            document.getElementById('metronome-timer').textContent =
                formatMetronomeTime(selectedMetronomeDurationSeconds * 1000);
            document.getElementById('metronome-progress').style.width = '0%';
            document.getElementById('metronome-status').textContent = 'Metronome test cancelled.';
            document.getElementById('metronome-result').textContent = '-- ms average error';
            clearMetronomeTimeline();
            closeMetronomeAudio(run);
        }

        function updateMetronomeUI() {
            if (metronomeState !== 'RUNNING' || !metronomeRun) return;

            const run = metronomeRun;
            const now = performance.now();
            const tapButton = document.getElementById('metronome-tap-btn');
            const status = document.getElementById('metronome-status');
            const elapsedMs = Math.max(0, now - run.beatOriginPerformanceMs);
            const totalMs = run.testEndPerformanceMs - run.beatOriginPerformanceMs;
            const progressPercent = Math.min(100, Math.max(0, elapsedMs / totalMs * 100));

            document.getElementById('metronome-progress').style.width = `${progressPercent}%`;
            document.getElementById('metronome-timer').textContent =
                formatMetronomeTime(run.testEndPerformanceMs - now);

            const inPractice = now < run.fullVolumeEndPerformanceMs;
            const inFade = !inPractice && now < run.silentStartPerformanceMs;
            tapButton.classList.toggle('practice', inPractice);
            tapButton.classList.toggle('fading', inFade);
            tapButton.classList.toggle('scoring', !inPractice && !inFade);

            let phaseStatus;
            if (inPractice) {
                tapButton.textContent = 'Tap Along — Practice';
                phaseStatus = `Listen and lock onto the beat. Full volume for ${Math.max(0, Math.ceil((run.fullVolumeEndPerformanceMs - now) / 1000))}s.`;
            } else if (inFade) {
                tapButton.textContent = 'Keep Tapping — Fading';
                phaseStatus = `Keep the same tempo. Sound disappears in ${Math.max(0, Math.ceil((run.silentStartPerformanceMs - now) / 1000))}s.`;
            } else {
                tapButton.textContent = 'Tap the Beat — Scored';
                phaseStatus = `Sound is off. Keep the learned tempo · ${run.taps.size} scored beats captured.`;
            }

            if (!run.feedbackUntilPerformanceMs || now >= run.feedbackUntilPerformanceMs) {
                status.textContent = phaseStatus;
            }
        }

        function handleMetronomePointerDown(event) {
            const pointerArrivalPerformanceMs = performance.now();
            event.preventDefault();

            if (metronomeState !== 'RUNNING' || !metronomeRun) return;

            const run = metronomeRun;
            const tapButton = document.getElementById('metronome-tap-btn');
            tapButton.classList.add('registered');
            setTimeout(() => tapButton.classList.remove('registered'), 70);

            // Audible and fading taps are useful practice but are deliberately omitted
            // from the score. The physical pointer delay measured by Input Calibration
            // is removed before assigning a tap to the nearest expected silent beat.
            const correctedTapPerformanceMs =
                pointerArrivalPerformanceMs - sessionLatencyOffsetMs;
            if (correctedTapPerformanceMs < run.silentStartPerformanceMs) {
                return;
            }
            if (correctedTapPerformanceMs >= run.testEndPerformanceMs) {
                return;
            }
            const expectedBeatIndex = Math.round(
                (correctedTapPerformanceMs - run.beatOriginPerformanceMs) /
                run.beatIntervalMs
            );

            if (
                expectedBeatIndex < run.firstExpectedBeatIndex ||
                expectedBeatIndex > run.lastExpectedBeatIndex
            ) {
                return;
            }
            const expectedPerformanceMs =
                run.beatOriginPerformanceMs + expectedBeatIndex * run.beatIntervalMs;
            const errorMs = correctedTapPerformanceMs - expectedPerformanceMs;
            const tap = {
                pointerArrivalPerformanceMs,
                correctedTapPerformanceMs,
                expectedPerformanceMs,
                errorMs
            };
            run.actualTaps.push(tap);

            if (run.taps.has(expectedBeatIndex)) {
                run.feedbackUntilPerformanceMs = pointerArrivalPerformanceMs + 450;
                document.getElementById('metronome-status').textContent =
                    'That expected beat already has a scored tap.';
                return;
            }

            run.taps.set(expectedBeatIndex, tap);

            const direction = errorMs < 0 ? 'early' : 'late';
            run.feedbackUntilPerformanceMs = pointerArrivalPerformanceMs + 450;
            document.getElementById('metronome-status').textContent =
                `Scored tap: ${Math.abs(errorMs).toFixed(1)} ms ${direction}.`;
        }

        async function startMetronomeTest() {
            if (metronomeState !== 'IDLE') return;

            const calibrationButton = document.getElementById('input-calibration-start-btn');
            const startButton = document.getElementById('metronome-start-btn');
            const tapButton = document.getElementById('metronome-tap-btn');
            const status = document.getElementById('metronome-status');
            const result = document.getElementById('metronome-result');

            if (calibrationButton.disabled) {
                status.textContent = 'Finish Input Delay Calibration before starting the metronome.';
                return;
            }

            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextCtor) {
                status.textContent = 'This browser does not support Web Audio.';
                return;
            }

            const runToken = ++metronomeRunToken;
            clearMetronomeTimeline();
            metronomeState = 'STARTING';
            setMetronomeControlsLocked(true);
            tapButton.disabled = true;
            result.textContent = '-- ms average error';
            status.textContent = 'Starting the audio clock...';
            document.getElementById('metronome-progress').style.width = '0%';

            let audioContext = null;
            try {
                audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
                await audioContext.resume();

                if (runToken !== metronomeRunToken) {
                    await audioContext.close();
                    return;
                }

                const bpm = Math.floor(
                    Math.random() * (METRONOME_MAX_BPM - METRONOME_MIN_BPM + 1)
                ) + METRONOME_MIN_BPM;
                const beatIntervalSeconds = 60 / bpm;
                const beatIntervalMs = beatIntervalSeconds * 1000;
                const leadAndFadeSeconds =
                    METRONOME_FULL_VOLUME_SECONDS + METRONOME_FADE_SECONDS;
                const durationSeconds = selectedMetronomeDurationSeconds;
                const beatOriginContextTime = audioContext.currentTime + 0.15;
                const fullVolumeEndContextTime =
                    beatOriginContextTime + METRONOME_FULL_VOLUME_SECONDS;
                const silentStartContextTime =
                    fullVolumeEndContextTime + METRONOME_FADE_SECONDS;
                const beatOriginPerformanceMs = mapMetronomeAudioTimeToPerformanceMs(
                    audioContext,
                    beatOriginContextTime
                );
                const fullVolumeEndPerformanceMs =
                    beatOriginPerformanceMs + METRONOME_FULL_VOLUME_SECONDS * 1000;
                const silentStartPerformanceMs =
                    beatOriginPerformanceMs + leadAndFadeSeconds * 1000;
                const testEndPerformanceMs =
                    silentStartPerformanceMs + durationSeconds * 1000;
                const firstExpectedBeatIndex = Math.ceil(
                    leadAndFadeSeconds * 1000 / beatIntervalMs - 1e-9
                );
                const lastExpectedBeatIndex = Math.floor(
                    (leadAndFadeSeconds * 1000 + durationSeconds * 1000 - 0.001) /
                    beatIntervalMs
                );

                const masterGain = audioContext.createGain();
                masterGain.gain.setValueAtTime(0, audioContext.currentTime);
                masterGain.gain.setValueAtTime(0.46, beatOriginContextTime);
                masterGain.gain.setValueAtTime(0.46, fullVolumeEndContextTime);
                masterGain.gain.linearRampToValueAtTime(0, silentStartContextTime);
                masterGain.connect(audioContext.destination);

                for (
                    let beatIndex = 0;
                    beatIndex * beatIntervalSeconds < leadAndFadeSeconds - 1e-9;
                    beatIndex += 1
                ) {
                    scheduleMetronomeClick(
                        audioContext,
                        masterGain,
                        beatOriginContextTime + beatIndex * beatIntervalSeconds,
                        beatIndex
                    );
                }

                metronomeRun = {
                    audioContext,
                    masterGain,
                    bpm,
                    beatIntervalMs,
                    durationSeconds,
                    beatOriginPerformanceMs,
                    fullVolumeEndPerformanceMs,
                    silentStartPerformanceMs,
                    testEndPerformanceMs,
                    firstExpectedBeatIndex,
                    lastExpectedBeatIndex,
                    taps: new Map(),
                    actualTaps: [],
                    feedbackUntilPerformanceMs: 0
                };
                metronomeState = 'RUNNING';
                tapButton.disabled = false;
                document.getElementById('metronome-bpm').textContent = `${bpm} BPM`;
                startButton.textContent = 'Metronome Test Running...';

                appendLog(
                    new Date().toISOString().substr(11, 8) + ' UTC',
                    `[METRONOME] Started ${durationSeconds}s silent challenge at ${bpm} BPM after 5s audible + 3s fade. Pointer correction: ${sessionLatencyOffsetMs.toFixed(2)}ms.`
                );

                updateMetronomeUI();
                metronomeUiIntervalId = setInterval(updateMetronomeUI, 50);
                metronomeFinishTimeoutId = setTimeout(
                    finishMetronomeTest,
                    Math.max(0, testEndPerformanceMs - performance.now()) + 5
                );
            } catch (error) {
                if (runToken !== metronomeRunToken) return;

                metronomeState = 'IDLE';
                metronomeRun = null;
                clearMetronomeTimers();
                resetMetronomeControls();
                document.getElementById('metronome-bpm').textContent = '-- BPM';
                document.getElementById('metronome-timer').textContent =
                    formatMetronomeTime(selectedMetronomeDurationSeconds * 1000);
                status.textContent = `Could not start metronome: ${error.message}`;
                startButton.textContent = 'Start Metronome Test';
                if (audioContext) {
                    Promise.resolve(audioContext.close()).catch(() => {});
                }
            }
        }

        getMetronomeDurationButtons().forEach((button) => {
            button.addEventListener('click', () => {
                setMetronomeDuration(Number(button.dataset.duration));
            });
        });
        document.getElementById('metronome-start-btn')
            .addEventListener('click', startMetronomeTest);
        document.getElementById('metronome-tap-btn')
            .addEventListener('pointerdown', handleMetronomePointerDown);

        async function toggleButton(id) {
            const wrapper = document.getElementById(`wrapper-${id}`);
            const isOpen = wrapper.classList.toggle('open');
            if (id === '2' && !isOpen && metronomeState !== 'IDLE') {
                cancelMetronomeTest();
            }
            
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
        let inputCalibrationCompletedOnce = false;

        function setInputCalibrationCollapsed(collapsed) {
            if (collapsed && !inputCalibrationCompletedOnce) {
                return false;
            }

            const calibrationCard = document.getElementById('input-calibration-card');
            const toggle = document.getElementById('input-calibration-toggle');
            const label = document.getElementById('input-calibration-toggle-label');
            calibrationCard.classList.toggle('collapsed', collapsed);
            toggle.setAttribute('aria-expanded', String(!collapsed));
            label.textContent = collapsed ? 'Expand' : 'Collapse';
            toggle.title = collapsed
                ? 'Expand Input Delay Calibration'
                : 'Collapse Input Delay Calibration';
            return true;
        }

        function unlockInputCalibrationCollapse() {
            inputCalibrationCompletedOnce = true;
            const toggle = document.getElementById('input-calibration-toggle');
            toggle.disabled = false;
            toggle.title = 'Collapse Input Delay Calibration';
        }

        document.getElementById('input-calibration-toggle').addEventListener('click', () => {
            const calibrationCard = document.getElementById('input-calibration-card');
            setInputCalibrationCollapsed(
                !calibrationCard.classList.contains('collapsed')
            );
        });

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
            const meterFill = document.getElementById('input-calibration-meter-fill');
            const meterStatus = document.getElementById('input-calibration-meter-status');
            const timerLabel = document.getElementById('input-calibration-timer');
            const calibrationPressBtn = document.getElementById('input-calibration-press-btn');
            const calibrationResult = document.getElementById('input-calibration-result');
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
                calibrationPressBtn.disabled = true;
                calibrationPressBtn.className = 'calibration-press-btn waiting';
                calibrationPressBtn.innerText = 'LISTEN FOR CALIBRATION PROBES...';
                calibrationResult.innerText = 'Keep speakers audible and the room reasonably quiet.';

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

                calibrationPressBtn.disabled = false;
                calibrationPressBtn.className = 'calibration-press-btn ready';
                calibrationPressBtn.innerText = `CALIBRATE — PRESS 1 OF ${MOUSE_PRESS_COUNT}`;
                calibrationResult.innerText = `Press this button ${MOUSE_PRESS_COUNT} times, about half a second apart.`;
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

                    calibrationPressBtn.disabled = true;
                    calibrationPressBtn.className = 'calibration-press-btn waiting';

                    if (pressNumber >= MOUSE_PRESS_COUNT) {
                        calibrationPressBtn.innerText = `${MOUSE_PRESS_COUNT}/${MOUSE_PRESS_COUNT} PRESSES CAPTURED`;
                        calibrationResult.innerText = 'All mouse presses captured. Keep still while recording finishes...';
                        meterStatus.innerText = 'MOUSE PRESSES CAPTURED — FINISHING RECORDING';
                        return;
                    }

                    calibrationPressBtn.innerText = `PRESS ${pressNumber + 1} OF ${MOUSE_PRESS_COUNT} — WAIT...`;
                    calibrationResult.innerText = `Captured ${pressNumber}/${MOUSE_PRESS_COUNT}. Press again when the button turns green.`;

                    calibrationReenableTimeoutId = setTimeout(() => {
                        calibrationReenableTimeoutId = null;
                        if (jsPointerOffsetsMs.length < MOUSE_PRESS_COUNT) {
                            calibrationPressBtn.disabled = false;
                            calibrationPressBtn.className = 'calibration-press-btn ready';
                            calibrationPressBtn.innerText = `CALIBRATE — PRESS ${jsPointerOffsetsMs.length + 1} OF ${MOUSE_PRESS_COUNT}`;
                        }
                    }, MOUSE_PRESS_COOLDOWN_MS);
                };

                calibrationPressBtn.addEventListener('pointerdown', calibrationPointerHandler, true);

                appendLog(
                    nowUTC(),
                    `[CALIB] Loopback probes complete. Press the calibration button ${MOUSE_PRESS_COUNT} times, about ${MOUSE_PRESS_COOLDOWN_MS}ms or more apart; recording remains on the same ${sampleRate}Hz stream.`
                );

                await recordingCompletePromise;
                timerLabel.innerText = '00:00';

                if (calibrationPointerHandler) {
                    calibrationPressBtn.removeEventListener('pointerdown', calibrationPointerHandler, true);
                    calibrationPointerHandler = null;
                }
                if (calibrationReenableTimeoutId !== null) {
                    clearTimeout(calibrationReenableTimeoutId);
                    calibrationReenableTimeoutId = null;
                }

                calibrationPressBtn.disabled = true;
                calibrationPressBtn.className = 'calibration-press-btn waiting';
                calibrationPressBtn.innerText = 'CALIBRATION PROCESSING...';

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
                    calibrationPressBtn.removeEventListener('pointerdown', calibrationPointerHandler, true);
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

        async function startInputCalibration() {
            const captureBtn = document.getElementById('input-calibration-start-btn');
            const meterStatus = document.getElementById('input-calibration-meter-status');
            const calibrationPressBtn = document.getElementById('input-calibration-press-btn');
            const calibrationResult = document.getElementById('input-calibration-result');
            const nowUTC = () => new Date().toISOString().substr(11, 8) + ' UTC';
            let autoCollapseAfterCompletion = false;

            if (captureBtn.disabled) return;
            if (metronomeState !== 'IDLE') {
                calibrationResult.innerText = 'Finish or cancel the Metronome Test before calibrating input delay.';
                meterStatus.innerText = 'Metronome Test In Progress';
                return;
            }

            captureBtn.disabled = true;
            calibrationPressBtn.disabled = true;
            calibrationPressBtn.className = 'calibration-press-btn waiting';
            calibrationPressBtn.innerText = 'PREPARING LOOPBACK...';
            calibrationResult.innerText = 'Keep laptop/external speakers audible. Do not use headphones.';
            meterStatus.innerText = 'Preparing Acoustic Calibration...';

            try {
                const calibration = await measureClickRegistrationAgainstAudio();

                sessionLatencyOffsetMs = calibration.correctionMs;
                calibrationResult.innerText = `Calibration locked: ${sessionLatencyOffsetMs.toFixed(2)} ms correction`;
                const calibrationTitleResult = document.getElementById('input-calibration-title-result');
                calibrationTitleResult.textContent = ` : ${sessionLatencyOffsetMs.toFixed(2)} ms`;
                calibrationTitleResult.hidden = false;
                appendLog(
                    nowUTC(),
                    `[SESSION LOCKED] Correction ${sessionLatencyOffsetMs.toFixed(2)}ms = median mouse-vs-audio ${calibration.observedMouseVsAudioDeltaMs.toFixed(2)}ms + measured loopback ${calibration.effectiveAudioReferenceDelayMs.toFixed(2)}ms. Mouse MAD ${calibration.mouseDeltaMadMs.toFixed(2)}ms, range ${calibration.mouseDeltaRangeMs.toFixed(2)}ms. Probe MAD ${calibration.probeMadMs.toFixed(2)}ms, range ${calibration.probeRangeMs.toFixed(2)}ms.`
                );
                if (!inputCalibrationCompletedOnce) {
                    unlockInputCalibrationCollapse();
                    autoCollapseAfterCompletion = true;
                }
            } catch (err) {
                calibrationResult.innerText = `Calibration failed: ${err.message}`;
                appendLog(nowUTC(), `[CALIBRATION ERROR] ${err.message}`);
            } finally {
                captureBtn.disabled = false;
                calibrationPressBtn.disabled = true;
                calibrationPressBtn.className = 'calibration-press-btn idle';
                calibrationPressBtn.innerText = 'Calibration Press Button';
                meterStatus.innerText = 'Input Level';
                if (autoCollapseAfterCompletion) {
                    setInputCalibrationCollapsed(true);
                }
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
                fetch(`/api/presence?${browserPresenceQuery}`, {
                    method: 'POST',
                    cache: 'no-store'
                }).catch(() => {});

                const response = await fetch('/api/status', { cache: 'no-store' });
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
