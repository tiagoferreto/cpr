import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createBandPass,
  createCompressionDetector,
  DEPTH_WINDOW_MS,
  estimateDepth,
  rateFromTimes,
  type FilteredSample,
} from "./signal";

type SensorStatus =
  | "idle"
  | "requesting"
  | "audio-ready"
  | "calibrating"
  | "active"
  | "stopped"
  | "denied"
  | "unsupported";

type RateFeedback = "waiting" | "good" | "faster" | "slower";
type DepthFeedback = "waiting" | "good" | "deeper" | "shallower";
type VoicePrompt = "audio-ready" | "faster" | "slower" | "deeper" | "shallower" | "good" | "rhythm-good";

const TARGET_RATE = 110;
const MIN_RATE = 100;
const MAX_RATE = 120;
const MIN_DEPTH = 4.5;
const MAX_DEPTH = 6.5;
const CALIBRATION_MS = 1_800;
const PAUSE_COMMIT = 0.88;

const AUDIO_BASE = `${import.meta.env.BASE_URL}audio/`;

const VOICE_FILES: Record<VoicePrompt, string> = {
  "audio-ready": `${AUDIO_BASE}audio-ready.mp3`,
  faster: `${AUDIO_BASE}faster.mp3`,
  slower: `${AUDIO_BASE}slower.mp3`,
  deeper: `${AUDIO_BASE}deeper.mp3`,
  shallower: `${AUDIO_BASE}shallower.mp3`,
  good: `${AUDIO_BASE}good.mp3`,
  "rhythm-good": `${AUDIO_BASE}rhythm-good.mp3`,
};

const statusCopy: Record<SensorStatus, string> = {
  idle: "Pronto para treinar",
  requesting: "Aguardando permissão",
  "audio-ready": "Pronto para começar",
  calibrating: "Calibrando sensor",
  active: "Sessão em andamento",
  stopped: "Sessão finalizada",
  denied: "Acesso não autorizado",
  unsupported: "Sensor indisponível",
};

const rateCopy: Record<RateFeedback, { title: string; detail: string }> = {
  waiting: { title: "Aguardando compressões", detail: "Comece acompanhando o pulso sonoro" },
  good: { title: "Ritmo adequado", detail: "Mantenha esta cadência" },
  faster: { title: "Aumente o ritmo", detail: "Comprima um pouco mais rápido" },
  slower: { title: "Diminua o ritmo", detail: "Comprima um pouco mais devagar" },
};

const depthCopy: Record<DepthFeedback, string> = {
  waiting: "Aguardando leitura",
  good: "Faixa estimada adequada",
  deeper: "Aumente a profundidade",
  shallower: "Diminua a profundidade",
};

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function createTone(context: AudioContext, when = context.currentTime) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, when);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.16, when + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(when);
  oscillator.stop(when + 0.06);
  return oscillator;
}

async function fetchVoiceData() {
  const results = await Promise.allSettled(
    (Object.entries(VOICE_FILES) as [VoicePrompt, string][]).map(async ([key, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Não foi possível carregar ${url}`);
      return [key, await response.arrayBuffer()] as const;
    }),
  );
  const data: Partial<Record<VoicePrompt, ArrayBuffer>> = {};
  for (const result of results) {
    if (result.status === "fulfilled") data[result.value[0]] = result.value[1];
  }
  return data;
}

function pauseMaxOffset(thumb: HTMLElement) {
  const track = thumb.parentElement;
  if (!track) return 1;
  return Math.max(1, track.getBoundingClientRect().width - thumb.getBoundingClientRect().width - 8);
}

export default function Home() {
  const [status, setStatus] = useState<SensorStatus>("idle");
  const [rate, setRate] = useState(0);
  const [depth, setDepth] = useState(0);
  const [compressions, setCompressions] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const [starting, setStarting] = useState(false);
  const [sensorError, setSensorError] = useState("");
  const [audioError, setAudioError] = useState("");
  const [notice, setNotice] = useState("");
  const [pauseDrag, setPauseDrag] = useState({ progress: 0, offset: 0 });

  const statusRef = useRef<SensorStatus>("idle");
  const samplesRef = useRef<FilteredSample[]>([]);
  const bandPassRef = useRef(createBandPass());
  const detectorRef = useRef(createCompressionDetector());
  const gravityRef = useRef({ x: 0, y: 0, z: 9.81 });
  const gravityReadyRef = useRef(false);
  const motionSamplesRef = useRef(0);
  const compressionTimesRef = useRef<number[]>([]);
  const lastPeakRef = useRef(0);
  const rateRef = useRef(0);
  const sessionStartRef = useRef(0);
  const calibrationTimerRef = useRef(0);
  const startingRef = useRef(false);
  const audioRef = useRef<AudioContext | null>(null);
  const voiceDataRef = useRef<Promise<Partial<Record<VoicePrompt, ArrayBuffer>>> | null>(null);
  const voiceBuffersRef = useRef<Partial<Record<VoicePrompt, AudioBuffer>>>({});
  const voiceSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const lastAnnouncementRef = useRef({ text: "", time: 0 });
  const pauseDragRef = useRef({ progress: 0, offset: 0 });
  const pauseStartXRef = useRef(0);

  const updateStatus = useCallback((next: SensorStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const stopVoice = useCallback(() => {
    try { voiceSourceRef.current?.stop(); } catch { /* Message already ended. */ }
  }, []);

  const playVoice = useCallback((prompt: VoicePrompt) => {
    const context = audioRef.current;
    const buffer = voiceBuffersRef.current[prompt];
    if (!context || !buffer || context.state !== "running") return false;

    stopVoice();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    voiceSourceRef.current = source;
    source.onended = () => {
      if (voiceSourceRef.current === source) voiceSourceRef.current = null;
    };
    return true;
  }, [stopVoice]);

  const rateFeedback = useMemo<RateFeedback>(() => {
    if (!rate) return "waiting";
    if (rate < MIN_RATE) return "faster";
    if (rate > MAX_RATE) return "slower";
    return "good";
  }, [rate]);

  const depthFeedback = useMemo<DepthFeedback>(() => {
    if (!depth) return "waiting";
    if (depth < MIN_DEPTH) return "deeper";
    if (depth > MAX_DEPTH) return "shallower";
    return "good";
  }, [depth]);

  const registerCompression = useCallback((time: number) => {
    const times = [...compressionTimesRef.current.filter((previous) => time - previous < 5_000), time].slice(-9);
    compressionTimesRef.current = times;
    lastPeakRef.current = time;
    setCompressions((value) => value + 1);

    const nextRate = rateFromTimes(times);
    if (!nextRate) return;
    const smoothedRate = rateRef.current ? Math.round(rateRef.current * 0.55 + nextRate * 0.45) : nextRate;
    rateRef.current = smoothedRate;
    setRate(smoothedRate);
    const recent = samplesRef.current.filter((sample) => sample.time >= time - DEPTH_WINDOW_MS);
    const nextDepth = estimateDepth(recent, smoothedRate);
    if (nextDepth) {
      setDepth((current) => current ? current * 0.62 + nextDepth * 0.38 : nextDepth);
    }
  }, []);

  const handleMotion = useCallback((event: DeviceMotionEvent) => {
    if (statusRef.current !== "active" && statusRef.current !== "calibrating") return;
    const includingGravity = event.accelerationIncludingGravity;
    // Some desktop and Android browsers expose the API but report null readings.
    if (!includingGravity || includingGravity.x === null || includingGravity.y === null || includingGravity.z === null) return;
    motionSamplesRef.current += 1;

    const measuredGravity = { x: includingGravity.x, y: includingGravity.y, z: includingGravity.z };
    const alpha = statusRef.current === "calibrating" ? 0.82 : 0.965;
    const previousGravity = gravityRef.current;
    const gravity = gravityReadyRef.current
      ? {
          x: alpha * previousGravity.x + (1 - alpha) * measuredGravity.x,
          y: alpha * previousGravity.y + (1 - alpha) * measuredGravity.y,
          z: alpha * previousGravity.z + (1 - alpha) * measuredGravity.z,
        }
      : measuredGravity;
    gravityReadyRef.current = true;
    gravityRef.current = gravity;
    if (statusRef.current === "calibrating") return;

    const direct = event.acceleration;
    const linear = direct && direct.x !== null
      ? { x: direct.x ?? 0, y: direct.y ?? 0, z: direct.z ?? 0 }
      : {
          x: measuredGravity.x - gravity.x,
          y: measuredGravity.y - gravity.y,
          z: measuredGravity.z - gravity.z,
        };
    const gravityMagnitude = Math.hypot(gravity.x, gravity.y, gravity.z) || 9.81;
    const vertical =
      (linear.x * gravity.x + linear.y * gravity.y + linear.z * gravity.z) /
      gravityMagnitude;
    const now = performance.now();

    const sample = { time: now, value: bandPassRef.current(now, vertical) };
    samplesRef.current.push(sample);
    samplesRef.current = samplesRef.current.filter((previous) => previous.time >= now - 2_200);

    const peak = detectorRef.current(sample);
    if (peak !== null) registerCompression(peak);
  }, [registerCompression]);

  useEffect(() => {
    window.addEventListener("devicemotion", handleMotion);
    return () => window.removeEventListener("devicemotion", handleMotion);
  }, [handleMotion]);

  useEffect(() => {
    voiceDataRef.current = fetchVoiceData();
    return () => window.clearTimeout(calibrationTimerRef.current);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (statusRef.current === "active") {
        setElapsed((performance.now() - sessionStartRef.current) / 1000);
        if (lastPeakRef.current && performance.now() - lastPeakRef.current > 1_600) {
          rateRef.current = 0;
          setRate(0);
          setDepth(0);
          compressionTimesRef.current = [];
        }
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  // Metronome scheduled on the audio clock so beats stay evenly spaced even when timers are throttled.
  useEffect(() => {
    if (status !== "active" || !soundOn) return;
    const context = audioRef.current;
    if (!context) return;
    const interval = 60 / TARGET_RATE;
    const scheduled = new Set<OscillatorNode>();
    let nextBeat = context.currentTime + 0.05;

    const schedule = () => {
      if (context.state !== "running") return;
      if (nextBeat < context.currentTime) nextBeat = context.currentTime + 0.05;
      while (nextBeat < context.currentTime + 0.12) {
        const oscillator = createTone(context, nextBeat);
        scheduled.add(oscillator);
        oscillator.onended = () => scheduled.delete(oscillator);
        nextBeat += interval;
      }
    };
    schedule();
    const timer = window.setInterval(schedule, 25);
    return () => {
      window.clearInterval(timer);
      for (const oscillator of scheduled) {
        try { oscillator.stop(); } catch { /* Already stopped. */ }
      }
    };
  }, [status, soundOn]);

  useEffect(() => {
    if (status !== "active" || !soundOn) return;
    let prompt: VoicePrompt | null = null;
    if (rateFeedback === "faster") prompt = "faster";
    else if (rateFeedback === "slower") prompt = "slower";
    else if (rateFeedback === "good" && depthFeedback === "deeper") prompt = "deeper";
    else if (rateFeedback === "good" && depthFeedback === "shallower") prompt = "shallower";
    else if (rateFeedback === "good" && depthFeedback === "good") prompt = "good";
    else if (rateFeedback === "good") prompt = "rhythm-good";

    if (!prompt) return;
    const now = performance.now();
    const last = lastAnnouncementRef.current;
    const repeatDelay = prompt === "good" || prompt === "rhythm-good" ? 7_000 : 4_000;
    if (now - last.time < repeatDelay && last.text === prompt) return;
    if (now - last.time < 2_500) return;

    if (playVoice(prompt)) lastAnnouncementRef.current = { text: prompt, time: now };
  }, [depthFeedback, rateFeedback, soundOn, status, rate, depth, playVoice]);

  // Nobody touches the screen during compressions, so keep it from auto-locking.
  const keepAwake = status === "active" || status === "calibrating";
  useEffect(() => {
    if (!keepAwake || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let released = false;
    navigator.wakeLock.request("screen").then((sentinel) => {
      if (released) void sentinel.release();
      else lock = sentinel;
    }).catch(() => undefined);
    return () => {
      released = true;
      void lock?.release().catch(() => undefined);
    };
  }, [keepAwake]);

  const resetMeasurements = () => {
    samplesRef.current = [];
    bandPassRef.current = createBandPass();
    detectorRef.current = createCompressionDetector();
    compressionTimesRef.current = [];
    lastPeakRef.current = 0;
    rateRef.current = 0;
    gravityRef.current = { x: 0, y: 0, z: 9.81 };
    gravityReadyRef.current = false;
    motionSamplesRef.current = 0;
    sessionStartRef.current = 0;
    lastAnnouncementRef.current = { text: "", time: 0 };
    pauseDragRef.current = { progress: 0, offset: 0 };
    setRate(0);
    setDepth(0);
    setCompressions(0);
    setElapsed(0);
    setNotice("");
    setPauseDrag({ progress: 0, offset: 0 });
  };

  /** Starts the audio context and decodes whichever voice prompts loaded. Returns whether sound can play. */
  const enableAudio = async () => {
    setAudioError("");
    try {
      const AudioConstructor = window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioConstructor) {
        setAudioError("Este navegador não oferece o sistema de áudio necessário. O treino segue sem som.");
        return false;
      }
      const context = audioRef.current ??= new AudioConstructor();
      await context.resume();
      createTone(context);
    } catch {
      setAudioError("O navegador bloqueou o áudio. Aumente o volume e toque em “Som desligado” para tentar de novo.");
      return false;
    }

    const missing = (Object.keys(VOICE_FILES) as VoicePrompt[]).filter((key) => !voiceBuffersRef.current[key]);
    if (missing.length) {
      voiceDataRef.current ??= fetchVoiceData();
      let data = await voiceDataRef.current;
      if (missing.some((key) => !data[key])) {
        voiceDataRef.current = fetchVoiceData();
        data = await voiceDataRef.current;
      }
      await Promise.all(missing.map(async (key) => {
        const encoded = data[key];
        if (!encoded) return;
        try {
          // decodeAudioData detaches its input, so keep the fetched copy for retries.
          voiceBuffersRef.current[key] = await audioRef.current!.decodeAudioData(encoded.slice(0));
        } catch {
          // Leave this prompt silent; the metronome still works.
        }
      }));
      if (missing.some((key) => !voiceBuffersRef.current[key])) {
        setAudioError("Algumas mensagens de voz não carregaram. O metrônomo continua funcionando.");
      }
    }
    return true;
  };

  const toggleSound = async () => {
    if (soundOn) {
      setSoundOn(false);
      stopVoice();
      return;
    }
    setSoundOn(true);
    // Before training starts, only record the preference; audio is enabled on "Começar".
    if (statusRef.current !== "active" && statusRef.current !== "calibrating") return;
    if (await enableAudio()) playVoice("audio-ready");
    else setSoundOn(false);
  };

  const requestAppFullscreen = () => {
    const root = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    const fullscreenDocument = document as Document & { webkitFullscreenElement?: Element | null };
    if (document.fullscreenElement || fullscreenDocument.webkitFullscreenElement) return;

    try {
      const request = root.requestFullscreen
        ? root.requestFullscreen({ navigationUI: "hide" })
        : root.webkitRequestFullscreen?.();
      if (request instanceof Promise) void request.catch(() => undefined);
    } catch {
      // Fullscreen is optional; sensor training remains available when unsupported.
    }
  };

  const exitAppFullscreen = () => {
    const fullscreenDocument = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    if (!document.fullscreenElement && !fullscreenDocument.webkitFullscreenElement) return;

    try {
      const exit = document.fullscreenElement
        ? document.exitFullscreen()
        : fullscreenDocument.webkitExitFullscreen?.();
      if (exit instanceof Promise) void exit.catch(() => undefined);
    } catch {
      // The browser may have already left fullscreen through a system gesture.
    }
  };

  const beginTraining = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    requestAppFullscreen();

    const withSound = soundOn && await enableAudio();
    if (soundOn && !withSound) setSoundOn(false);
    if (withSound) playVoice("audio-ready");
    lastAnnouncementRef.current = { text: "", time: performance.now() };
    motionSamplesRef.current = 0;
    updateStatus("calibrating");
    startingRef.current = false;
    setStarting(false);

    calibrationTimerRef.current = window.setTimeout(() => {
      calibrationTimerRef.current = 0;
      if (statusRef.current !== "calibrating") return;
      if (!motionSamplesRef.current) {
        updateStatus("unsupported");
        exitAppFullscreen();
        stopVoice();
        return;
      }
      sessionStartRef.current = performance.now();
      updateStatus("active");
    }, CALIBRATION_MS);
  };

  const startSession = async () => {
    if (!("DeviceMotionEvent" in window)) {
      updateStatus("unsupported");
      return;
    }
    resetMeasurements();
    updateStatus("requesting");
    setSensorError("");

    try {
      const MotionEvent = DeviceMotionEvent as typeof DeviceMotionEvent & {
        requestPermission?: () => Promise<"granted" | "denied">;
      };
      if (typeof MotionEvent.requestPermission === "function") {
        const permission = await MotionEvent.requestPermission();
        if (permission !== "granted") {
          setSensorError("O navegador recusou o acesso. Redefina a permissão de movimento deste site e tente novamente.");
          updateStatus("denied");
          return;
        }
      }
      setAudioError("");
      updateStatus("audio-ready");
    } catch (error) {
      const message = error instanceof Error && error.name === "NotAllowedError"
        ? "O navegador bloqueou a solicitação. Abra a página diretamente no Safari ou Chrome e toque novamente."
        : "Não foi possível solicitar o sensor de movimento neste navegador.";
      setSensorError(message);
      updateStatus("denied");
    }
  };

  const stopSession = useCallback(() => {
    if (statusRef.current !== "active") return;
    setElapsed((performance.now() - sessionStartRef.current) / 1_000);
    compressionTimesRef.current = [];
    updateStatus("stopped");
    exitAppFullscreen();
    stopVoice();
  }, [stopVoice, updateStatus]);

  // Motion events stop while the page is hidden (screen lock, app switch), so end the session cleanly.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      if (statusRef.current === "active") {
        stopSession();
        setNotice("Sessão interrompida porque o app saiu da tela.");
      } else if (statusRef.current === "calibrating") {
        window.clearTimeout(calibrationTimerRef.current);
        stopVoice();
        updateStatus("audio-ready");
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [stopSession, stopVoice, updateStatus]);

  const updatePauseDrag = (next: { progress: number; offset: number }) => {
    pauseDragRef.current = next;
    setPauseDrag(next);
  };

  const handlePauseDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    pauseStartXRef.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
    updatePauseDrag({ progress: 0, offset: 0 });
  };

  const handlePauseDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const maxOffset = pauseMaxOffset(event.currentTarget);
    const offset = Math.min(maxOffset, Math.max(0, event.clientX - pauseStartXRef.current));
    updatePauseDrag({ progress: offset / maxOffset, offset });
  };

  const finishPauseDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pauseDragRef.current.progress >= PAUSE_COMMIT) stopSession();
    updatePauseDrag({ progress: 0, offset: 0 });
  };

  const handlePauseSliderKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Home") {
      event.preventDefault();
      updatePauseDrag({ progress: 0, offset: 0 });
      return;
    }
    if (event.key !== "ArrowRight" && event.key !== "End") return;
    event.preventDefault();
    const progress = event.key === "End" ? 1 : Math.min(1, pauseDragRef.current.progress + 0.2);
    if (progress >= PAUSE_COMMIT) {
      stopSession();
      updatePauseDrag({ progress: 0, offset: 0 });
    } else {
      updatePauseDrag({ progress, offset: progress * pauseMaxOffset(event.currentTarget) });
    }
  };

  const sessionStarted = status === "active" || status === "calibrating" || status === "audio-ready";
  const rateProgress = rate ? Math.min(100, Math.max(0, ((rate - 70) / 80) * 100)) : 0;
  const depthMarker = depth ? Math.min(100, Math.max(0, (depth / 8) * 100)) : 0;
  const message = audioError
    || (status === "denied" ? sensorError || "Autorize o acesso a movimento nas configurações do navegador." : "")
    || (status === "unsupported" ? "Este navegador ou dispositivo não oferece os dados de movimento necessários." : "")
    || (status === "stopped" ? notice : "");

  return (
    <main className={`app-shell feedback-${rateFeedback}`}>
      <header className="topbar">
        <div className="brand" aria-label="Pulso">
          <span className="brand-mark" aria-hidden="true">♥</span>
          <span>Pulso</span>
        </div>
        <div className={`status-pill status-${status}`} role="status" aria-live="polite">
          <span className="status-dot" />
          {statusCopy[status]}
        </div>
      </header>

      <aside className="emergency-strip" role="note">
        <span>Emergência real: ligue 192 e siga o SAMU.</span>
        <a href="tel:192" aria-label="Ligar para o SAMU no número 192">Ligar 192</a>
      </aside>

      <section className="training-stage" aria-label="Feedback de compressões torácicas">
        <div className="stage-tools">
          <span>Ritmo alvo: 100–120/min</span>
          <button
            className={`sound-toggle ${soundOn ? "is-on" : ""}`}
            type="button"
            onClick={toggleSound}
            aria-pressed={soundOn}
            aria-label={soundOn ? "Desligar som" : "Ligar som"}
          >
            <span aria-hidden="true">{soundOn ? "◖))" : "◖×"}</span>
            {soundOn ? "Som ligado" : "Som desligado"}
          </button>
        </div>

        <div className="rate-visual" style={{ "--rate-progress": `${rateProgress}%` } as React.CSSProperties}>
          <div className="rate-ring">
            <div className="rate-number">
              <strong>{rate || "—"}</strong>
              <span>compressões/min</span>
            </div>
          </div>
        </div>

        <div className="live-feedback">
          <span className="feedback-icon" aria-hidden="true">
            {rateFeedback === "good" ? "✓" : rateFeedback === "faster" ? "↑" : rateFeedback === "slower" ? "↓" : "·"}
          </span>
          <div>
            {/* Only the headline is announced, and politely, so screen readers are not interrupted on every change. */}
            <strong role="status" aria-live="polite">{rateCopy[rateFeedback].title}</strong>
            <span>{rateCopy[rateFeedback].detail}</span>
          </div>
        </div>

        <div className={`depth-card depth-${depthFeedback}`}>
          <div className="depth-heading">
            <span>Profundidade estimada</span>
            <strong>{depth ? depth.toFixed(1).replace(".", ",") : "—"}<small> cm</small></strong>
          </div>
          <div className="depth-track" aria-label="Alvo estimado entre 4,5 e 6,5 centímetros">
            <i
              className="depth-target"
              style={{ left: `${(MIN_DEPTH / 8) * 100}%`, width: `${((MAX_DEPTH - MIN_DEPTH) / 8) * 100}%` }}
            />
            {depth > 0 && <i className="depth-marker" style={{ left: `${depthMarker}%` }} />}
          </div>
          <div className="depth-caption">
            <span>{depthCopy[depthFeedback]}</span>
            <b>alvo 4,5–6,5 cm · experimental</b>
          </div>
        </div>
      </section>

      <section className="session-dock" aria-label="Controles da sessão">
        <div className="session-stats">
          <div><span>Tempo</span><strong>{formatTime(elapsed)}</strong></div>
          <div><span>Compressões</span><strong>{compressions}</strong></div>
        </div>

        <div className="session-action">
          {!sessionStarted ? (
            <button className="primary-button" onClick={startSession} disabled={status === "requesting"}>
              <span>{status === "requesting" ? "Solicitando acesso…" : status === "denied" ? "Tentar novamente" : "Começar"}</span>
              <b aria-hidden="true">→</b>
            </button>
          ) : status === "audio-ready" ? (
            <button className="primary-button" onClick={beginTraining} disabled={starting}>
              <span>{starting ? "Preparando…" : soundOn ? "Ativar áudio e começar" : "Começar sem som"}</span>
              <b aria-hidden="true">{soundOn ? "◖))" : "→"}</b>
            </button>
          ) : status === "calibrating" ? (
            <div className="calibrating-card" role="status">
              <i /><span>Calibrando… mantenha o aparelho imóvel</span>
            </div>
          ) : (
            <div
              className={`pause-slider ${pauseDrag.progress > 0 ? "is-dragging" : ""}`}
              style={{ "--pause-progress": `${pauseDrag.progress * 100}%` } as React.CSSProperties}
            >
              <i className="pause-slider-fill" aria-hidden="true" />
              <span className="pause-slider-label">
                {pauseDrag.progress > 0.62 ? "Continue arrastando" : "Deslize para parar"}
              </span>
              <div
                className="pause-slider-thumb"
                role="slider"
                tabIndex={0}
                aria-label="Deslize para parar a sessão"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pauseDrag.progress * 100)}
                style={{ transform: `translateX(${pauseDrag.offset}px)` }}
                onPointerDown={handlePauseDragStart}
                onPointerMove={handlePauseDragMove}
                onPointerUp={finishPauseDrag}
                onPointerCancel={finishPauseDrag}
                onKeyDown={handlePauseSliderKey}
              >
                <span aria-hidden="true">■</span>
                <b aria-hidden="true">›</b>
              </div>
            </div>
          )}
        </div>

        {message && <p className="sensor-error">{message}</p>}

        <p className="medical-note">Protótipo educacional: profundidade aproximada, não mede pressão e não substitui treinamento certificado.</p>
      </section>
    </main>
  );
}
