"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SensorStatus =
  | "idle"
  | "requesting"
  | "audio-ready"
  | "calibrating"
  | "active"
  | "paused"
  | "denied"
  | "unsupported";

type RateFeedback = "waiting" | "good" | "faster" | "slower";
type DepthFeedback = "waiting" | "good" | "deeper" | "shallower";
type MotionSample = { time: number; vertical: number };
type VoicePrompt = "audio-ready" | "faster" | "slower" | "deeper" | "shallower" | "good" | "rhythm-good";

const TARGET_RATE = 110;
const MIN_RATE = 100;
const MAX_RATE = 120;
const MIN_DEPTH = 5;
const MAX_DEPTH = 6;

const VOICE_FILES: Record<VoicePrompt, string> = {
  "audio-ready": "/audio/audio-ready.wav",
  faster: "/audio/faster.wav",
  slower: "/audio/slower.wav",
  deeper: "/audio/deeper.wav",
  shallower: "/audio/shallower.wav",
  good: "/audio/good.wav",
  "rhythm-good": "/audio/rhythm-good.wav",
};

const statusCopy: Record<SensorStatus, string> = {
  idle: "Pronto para treinar",
  requesting: "Aguardando permissão",
  "audio-ready": "Ative o retorno sonoro",
  calibrating: "Calibrando sensor",
  active: "Sessão em andamento",
  paused: "Sessão pausada",
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

function median(values: number[]) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function createTone(context: AudioContext) {
  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.06);
}

export default function Home() {
  const [status, setStatus] = useState<SensorStatus>("idle");
  const [rate, setRate] = useState(0);
  const [depth, setDepth] = useState(0);
  const [compressions, setCompressions] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const [sensorError, setSensorError] = useState("");
  const [audioError, setAudioError] = useState("");

  const statusRef = useRef<SensorStatus>("idle");
  const samplesRef = useRef<MotionSample[]>([]);
  const gravityRef = useRef({ x: 0, y: 0, z: 9.81 });
  const peakWindowRef = useRef<{ time: number; value: number }[]>([]);
  const compressionTimesRef = useRef<number[]>([]);
  const lastPeakRef = useRef(0);
  const sessionStartRef = useRef(0);
  const accumulatedRef = useRef(0);
  const audioRef = useRef<AudioContext | null>(null);
  const voiceBuffersRef = useRef<Partial<Record<VoicePrompt, AudioBuffer>>>({});
  const voiceSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const voiceUntilRef = useRef(0);
  const lastAnnouncementRef = useRef({ text: "", time: 0 });

  const updateStatus = useCallback((next: SensorStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const playVoice = useCallback((prompt: VoicePrompt) => {
    const context = audioRef.current;
    const buffer = voiceBuffersRef.current[prompt];
    if (!context || !buffer || context.state !== "running") return false;

    try {
      voiceSourceRef.current?.stop();
    } catch {
      // The previous message may already have finished.
    }
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    voiceSourceRef.current = source;
    voiceUntilRef.current = performance.now() + buffer.duration * 1_000 + 250;
    source.onended = () => {
      if (voiceSourceRef.current === source) voiceSourceRef.current = null;
    };
    return true;
  }, []);

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

  const estimateDepth = useCallback((bpm: number, now: number) => {
    const windowSamples = samplesRef.current.filter((sample) => sample.time >= now - 1_600);
    if (windowSamples.length < 12 || bpm < 70) return 0;
    const mean = windowSamples.reduce((sum, sample) => sum + sample.vertical, 0) / windowSamples.length;
    const rms = Math.sqrt(
      windowSamples.reduce((sum, sample) => sum + (sample.vertical - mean) ** 2, 0) /
        windowSamples.length,
    );
    const angularFrequency = 2 * Math.PI * (bpm / 60);
    const estimatedCm = (2 * rms * Math.SQRT2 * 100) / (angularFrequency ** 2);
    return Math.min(8.5, Math.max(0, estimatedCm));
  }, []);

  const registerCompression = useCallback((now: number) => {
    const times = compressionTimesRef.current.filter((time) => now - time < 5_000);
    times.push(now);
    compressionTimesRef.current = times.slice(-9);
    lastPeakRef.current = now;
    setCompressions((value) => value + 1);

    if (times.length < 3) return;
    const intervals = times.slice(1).map((time, index) => time - times[index]);
    const validIntervals = intervals.filter((interval) => interval >= 300 && interval <= 950);
    if (validIntervals.length < 2) return;
    const nextRate = Math.round(60_000 / median(validIntervals));
    setRate((current) => current ? Math.round(current * 0.55 + nextRate * 0.45) : nextRate);
    const nextDepth = estimateDepth(nextRate, now);
    if (nextDepth) {
      setDepth((current) => current ? current * 0.62 + nextDepth * 0.38 : nextDepth);
    }
  }, [estimateDepth]);

  const handleMotion = useCallback((event: DeviceMotionEvent) => {
    if (statusRef.current !== "active" && statusRef.current !== "calibrating") return;
    const includingGravity = event.accelerationIncludingGravity;
    if (!includingGravity) return;

    const alpha = statusRef.current === "calibrating" ? 0.82 : 0.965;
    const previousGravity = gravityRef.current;
    const gravity = {
      x: alpha * previousGravity.x + (1 - alpha) * (includingGravity.x ?? 0),
      y: alpha * previousGravity.y + (1 - alpha) * (includingGravity.y ?? 0),
      z: alpha * previousGravity.z + (1 - alpha) * (includingGravity.z ?? 0),
    };
    gravityRef.current = gravity;
    if (statusRef.current === "calibrating") return;

    const direct = event.acceleration;
    const linear = direct && direct.x !== null
      ? { x: direct.x ?? 0, y: direct.y ?? 0, z: direct.z ?? 0 }
      : {
          x: (includingGravity.x ?? 0) - gravity.x,
          y: (includingGravity.y ?? 0) - gravity.y,
          z: (includingGravity.z ?? 0) - gravity.z,
        };
    const gravityMagnitude = Math.hypot(gravity.x, gravity.y, gravity.z) || 9.81;
    const vertical =
      (linear.x * gravity.x + linear.y * gravity.y + linear.z * gravity.z) /
      gravityMagnitude;
    const now = performance.now();

    samplesRef.current.push({ time: now, vertical });
    samplesRef.current = samplesRef.current.filter((sample) => sample.time >= now - 2_200);

    const window = peakWindowRef.current;
    window.push({ time: now, value: Math.abs(vertical) });
    peakWindowRef.current = window.slice(-3);
    if (peakWindowRef.current.length < 3) return;

    const [first, middle, last] = peakWindowRef.current;
    const isPeak = middle.value > 1.1 && middle.value > first.value && middle.value >= last.value;
    if (isPeak && middle.time - lastPeakRef.current > 340) registerCompression(middle.time);
  }, [registerCompression]);

  useEffect(() => {
    window.addEventListener("devicemotion", handleMotion);
    return () => window.removeEventListener("devicemotion", handleMotion);
  }, [handleMotion]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (statusRef.current === "active") {
        setElapsed(accumulatedRef.current + (performance.now() - sessionStartRef.current) / 1000);
        if (lastPeakRef.current && performance.now() - lastPeakRef.current > 1_600) {
          setRate(0);
          setDepth(0);
          compressionTimesRef.current = [];
        }
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (status !== "active" || !soundOn) return;
    const context = audioRef.current;
    if (!context) return;
    const tick = () => {
      if (performance.now() >= voiceUntilRef.current) createTone(context);
    };
    tick();
    const metronome = window.setInterval(tick, 60_000 / TARGET_RATE);
    return () => window.clearInterval(metronome);
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

  const resetMeasurements = () => {
    samplesRef.current = [];
    peakWindowRef.current = [];
    compressionTimesRef.current = [];
    lastPeakRef.current = 0;
    setRate(0);
    setDepth(0);
    setCompressions(0);
    setElapsed(0);
    accumulatedRef.current = 0;
  };

  const enableAudio = async () => {
    setAudioError("");
    try {
      const AudioConstructor = window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioConstructor) {
        setSoundOn(false);
        setAudioError("Este navegador não oferece o sistema de áudio necessário.");
        return false;
      }
      audioRef.current ??= new AudioConstructor();
      await audioRef.current.resume();
      createTone(audioRef.current);
      if (Object.keys(voiceBuffersRef.current).length !== Object.keys(VOICE_FILES).length) {
        const entries = await Promise.all(
          (Object.entries(VOICE_FILES) as [VoicePrompt, string][]).map(async ([key, url]) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Não foi possível carregar ${url}`);
            const data = await response.arrayBuffer();
            const buffer = await audioRef.current!.decodeAudioData(data);
            return [key, buffer] as const;
          }),
        );
        voiceBuffersRef.current = Object.fromEntries(entries) as Record<VoicePrompt, AudioBuffer>;
      }
      setSoundOn(true);
      return true;
    } catch {
      setSoundOn(false);
      setAudioError("O navegador bloqueou o áudio. Aumente o volume e toque novamente em ativar áudio.");
      return false;
    }
  };

  const toggleSound = async () => {
    if (soundOn) {
      setSoundOn(false);
      try { voiceSourceRef.current?.stop(); } catch { /* Message already ended. */ }
      return;
    }
    const enabled = await enableAudio();
    if (enabled) playVoice("audio-ready");
  };

  const beginTrainingWithAudio = async () => {
    const enabled = await enableAudio();
    if (!enabled) return;
    playVoice("audio-ready");
    lastAnnouncementRef.current = { text: "", time: performance.now() };
    updateStatus("calibrating");
    window.setTimeout(() => {
      sessionStartRef.current = performance.now();
      updateStatus("active");
    }, 1_800);
  };

  const startSession = async () => {
    if (!("DeviceMotionEvent" in window)) {
      updateStatus("unsupported");
      return;
    }
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

      resetMeasurements();
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

  const togglePause = () => {
    if (status === "active") {
      accumulatedRef.current += (performance.now() - sessionStartRef.current) / 1000;
      updateStatus("paused");
      try { voiceSourceRef.current?.stop(); } catch { /* Message already ended. */ }
    } else if (status === "paused") {
      sessionStartRef.current = performance.now();
      updateStatus("active");
    }
  };

  const resetSession = () => {
    resetMeasurements();
    sessionStartRef.current = performance.now();
  };

  const sessionStarted = status === "active" || status === "paused" || status === "calibrating" || status === "audio-ready";
  const rateProgress = rate ? Math.min(100, Math.max(0, ((rate - 70) / 80) * 100)) : 0;
  const depthMarker = depth ? Math.min(100, Math.max(0, (depth / 8) * 100)) : 0;

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

        <div className="live-feedback" role="status" aria-live="assertive">
          <span className="feedback-icon" aria-hidden="true">
            {rateFeedback === "good" ? "✓" : rateFeedback === "faster" ? "↑" : rateFeedback === "slower" ? "↓" : "·"}
          </span>
          <div>
            <strong>{rateCopy[rateFeedback].title}</strong>
            <span>{rateCopy[rateFeedback].detail}</span>
          </div>
        </div>

        <div className={`depth-card depth-${depthFeedback}`}>
          <div className="depth-heading">
            <span>Profundidade estimada</span>
            <strong>{depth ? depth.toFixed(1).replace(".", ",") : "—"}<small> cm</small></strong>
          </div>
          <div className="depth-track" aria-label="Alvo estimado entre 5 e 6 centímetros">
            <i className="depth-target" />
            {depth > 0 && <i className="depth-marker" style={{ left: `${depthMarker}%` }} />}
          </div>
          <div className="depth-caption">
            <span>{depthCopy[depthFeedback]}</span>
            <b>alvo 5–6 cm · experimental</b>
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
              <span>{status === "requesting" ? "Solicitando acesso…" : status === "denied" ? "Tentar novamente" : "Iniciar treinamento"}</span>
              <b aria-hidden="true">→</b>
            </button>
          ) : status === "audio-ready" ? (
            <button className="primary-button" onClick={beginTrainingWithAudio}>
              <span>Ativar áudio e começar</span>
              <b aria-hidden="true">◖))</b>
            </button>
          ) : status === "calibrating" ? (
            <div className="calibrating-card" role="status">
              <i /><span>Calibrando… mantenha o aparelho imóvel</span>
            </div>
          ) : (
            <div className="control-row">
              <button className="icon-button" onClick={resetSession} aria-label="Reiniciar sessão" title="Reiniciar sessão">↺</button>
              <button className="primary-button" onClick={togglePause}>
                <span>{status === "paused" ? "Continuar" : "Pausar"}</span>
                <b aria-hidden="true">{status === "paused" ? "▶" : "Ⅱ"}</b>
              </button>
            </div>
          )}
        </div>

        {(status === "denied" || status === "unsupported" || audioError) && (
          <p className="sensor-error">
            {audioError || (status === "denied"
              ? sensorError || "Autorize o acesso a movimento nas configurações do navegador."
              : "Este navegador ou dispositivo não oferece os dados de movimento necessários.")}
          </p>
        )}

        <p className="medical-note">Protótipo educacional: profundidade aproximada, não mede pressão e não substitui treinamento certificado.</p>
      </section>
    </main>
  );
}
