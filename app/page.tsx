"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type AxisSample = {
  time: number;
  x: number;
  y: number;
  z: number;
};

type SensorStatus = "idle" | "requesting" | "active" | "paused" | "denied" | "unsupported";

const WINDOW_MS = 12_000;
const AXES = [
  { key: "x" as const, label: "Eixo X", color: "#c9ff57" },
  { key: "y" as const, label: "Eixo Y", color: "#57d9ff" },
  { key: "z" as const, label: "Eixo Z", color: "#c78bff" },
];

const statusCopy: Record<SensorStatus, string> = {
  idle: "Pronto para começar",
  requesting: "Aguardando permissão",
  active: "Leitura em tempo real",
  paused: "Leitura pausada",
  denied: "Acesso não autorizado",
  unsupported: "Sensor indisponível",
};

function formatValue(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function drawChart(canvas: HTMLCanvasElement, samples: AxisSample[], now: number) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = rect.width;
  const height = rect.height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const pad = { top: 18, right: 18, bottom: 32, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const visible = samples.filter((sample) => sample.time >= now - WINDOW_MS);
  const maxSeen = visible.reduce(
    (max, sample) => Math.max(max, Math.abs(sample.x), Math.abs(sample.y), Math.abs(sample.z)),
    0,
  );
  const limit = Math.max(12, Math.ceil(maxSeen / 5) * 5);

  ctx.font = "11px var(--font-geist-mono), monospace";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (plotH * i) / 4;
    const value = limit - (limit * 2 * i) / 4;
    ctx.strokeStyle = i === 2 ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.085)";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(229,232,225,.52)";
    ctx.textAlign = "right";
    ctx.fillText(String(value), pad.left - 10, y);
  }

  for (let i = 0; i <= 4; i += 1) {
    const x = pad.left + (plotW * i) / 4;
    ctx.strokeStyle = "rgba(255,255,255,.055)";
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, height - pad.bottom);
    ctx.stroke();
    ctx.fillStyle = "rgba(229,232,225,.46)";
    ctx.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
    ctx.fillText(`${Math.round(-12 + i * 3)}s`, x, height - 13);
  }

  const xFor = (time: number) => pad.left + ((time - (now - WINDOW_MS)) / WINDOW_MS) * plotW;
  const yFor = (value: number) => pad.top + ((limit - value) / (limit * 2)) * plotH;

  AXES.forEach((axis) => {
    ctx.strokeStyle = axis.color;
    ctx.lineWidth = 2.25;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = axis.color;
    ctx.shadowBlur = 7;
    ctx.beginPath();
    visible.forEach((sample, index) => {
      const x = xFor(sample.time);
      const y = yFor(sample[axis.key]);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
  });
}

export default function Home() {
  const [status, setStatus] = useState<SensorStatus>("idle");
  const [values, setValues] = useState({ x: 0, y: 0, z: 0 });
  const [frequency, setFrequency] = useState(0);
  const [sampleCount, setSampleCount] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<AxisSample[]>([]);
  const statusRef = useRef<SensorStatus>("idle");
  const latestTimeRef = useRef(0);
  const lastUiUpdateRef = useRef(0);

  const updateStatus = useCallback((next: SensorStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const handleMotion = useCallback((event: DeviceMotionEvent) => {
    if (statusRef.current !== "active") return;

    const acceleration = event.accelerationIncludingGravity ?? event.acceleration;
    if (!acceleration) return;

    const now = performance.now();
    const next = {
      time: now,
      x: acceleration.x ?? 0,
      y: acceleration.y ?? 0,
      z: acceleration.z ?? 0,
    };

    samplesRef.current.push(next);
    samplesRef.current = samplesRef.current.filter((sample) => sample.time >= now - WINDOW_MS - 1_000);
    latestTimeRef.current = now;

    if (now - lastUiUpdateRef.current > 90) {
      setValues({ x: next.x, y: next.y, z: next.z });
      setSampleCount((count) => count + 1);
      setFrequency(event.interval ? Math.round(1000 / event.interval) : 0);
      lastUiUpdateRef.current = now;
    }
  }, []);

  useEffect(() => {
    window.addEventListener("devicemotion", handleMotion);
    return () => window.removeEventListener("devicemotion", handleMotion);
  }, [handleMotion]);

  useEffect(() => {
    let frame = 0;
    const render = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const now = statusRef.current === "paused" && latestTimeRef.current
          ? latestTimeRef.current
          : performance.now();
        drawChart(canvas, samplesRef.current, now);
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  const startSensor = async () => {
    if (!("DeviceMotionEvent" in window)) {
      updateStatus("unsupported");
      return;
    }

    updateStatus("requesting");
    try {
      const MotionEvent = DeviceMotionEvent as typeof DeviceMotionEvent & {
        requestPermission?: () => Promise<"granted" | "denied">;
      };

      if (typeof MotionEvent.requestPermission === "function") {
        const permission = await MotionEvent.requestPermission();
        if (permission !== "granted") {
          updateStatus("denied");
          return;
        }
      }
      updateStatus("active");
    } catch {
      updateStatus("denied");
    }
  };

  const togglePause = () => {
    if (status === "active") updateStatus("paused");
    else if (status === "paused") updateStatus("active");
  };

  const clearChart = () => {
    samplesRef.current = [];
    latestTimeRef.current = 0;
    setValues({ x: 0, y: 0, z: 0 });
    setSampleCount(0);
  };

  const isRunning = status === "active" || status === "paused";

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Acelera — início">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>Acelera</span>
        </a>
        <div className={`status-pill status-${status}`} role="status" aria-live="polite">
          <span className="status-dot" />
          {statusCopy[status]}
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">Laboratório de movimento</p>
          <h1>Seu movimento,<br /><span>traçado ao vivo.</span></h1>
        </div>
        <p className="hero-copy">
          Acompanhe a aceleração do dispositivo nos três eixos. Os valores são processados
          somente nesta tela e não são enviados para nenhum servidor.
        </p>
      </section>

      <section className="dashboard" aria-label="Painel do acelerômetro">
        <div className="chart-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Aceleração incluindo gravidade</p>
              <h2>Intensidade por eixo</h2>
            </div>
            <div className="legend" aria-label="Legenda dos eixos">
              {AXES.map((axis) => (
                <span key={axis.key}><i style={{ background: axis.color }} />{axis.key.toUpperCase()}</span>
              ))}
            </div>
          </div>

          <div className="chart-wrap">
            <canvas ref={canvasRef} aria-label="Gráfico em tempo real dos eixos X, Y e Z" />
            {!isRunning && (
              <div className="chart-empty">
                <span className="signal-icon" aria-hidden="true"><i /><i /><i /></span>
                <strong>{status === "denied" ? "Permissão necessária" : status === "unsupported" ? "Sensor não encontrado" : "Aguardando o sensor"}</strong>
                <small>
                  {status === "denied"
                    ? "Autorize o acesso a movimento nas configurações do navegador e tente novamente."
                    : status === "unsupported"
                      ? "Abra esta página em um celular compatível usando uma conexão segura."
                      : "Toque em “Iniciar leitura” e movimente o celular."}
                </small>
              </div>
            )}
          </div>

          <div className="chart-footer">
            <span>Janela de 12 segundos</span>
            <span>Escala automática · m/s²</span>
          </div>
        </div>

        <aside className="side-panel">
          <div className="axis-list">
            {AXES.map((axis) => (
              <div className="axis-row" key={axis.key}>
                <div className="axis-name">
                  <span style={{ color: axis.color }}>{axis.key.toUpperCase()}</span>
                  <small>{axis.label}</small>
                </div>
                <div className="axis-value">
                  <strong>{formatValue(values[axis.key])}</strong>
                  <small>m/s²</small>
                </div>
              </div>
            ))}
          </div>

          <div className="metrics">
            <div><span>Taxa</span><strong>{frequency || "—"} <small>{frequency ? "Hz" : ""}</small></strong></div>
            <div><span>Amostras</span><strong>{sampleCount}</strong></div>
          </div>

          {!isRunning ? (
            <button className="primary-button" onClick={startSensor} disabled={status === "requesting"}>
              <span>{status === "requesting" ? "Solicitando…" : status === "denied" ? "Tentar novamente" : "Iniciar leitura"}</span>
              <b aria-hidden="true">→</b>
            </button>
          ) : (
            <div className="control-row">
              <button className="primary-button" onClick={togglePause}>
                <span>{status === "paused" ? "Continuar" : "Pausar"}</span>
                <b aria-hidden="true">{status === "paused" ? "▶" : "Ⅱ"}</b>
              </button>
              <button className="icon-button" onClick={clearChart} aria-label="Limpar gráfico" title="Limpar gráfico">↺</button>
            </div>
          )}

          <p className="permission-note">
            <span aria-hidden="true">⌁</span>
            No iPhone, o navegador pedirá sua autorização após o toque no botão.
          </p>
        </aside>
      </section>

      <footer>
        <span>Dados locais · nenhuma gravação</span>
        <span>Compatível com navegadores móveis modernos</span>
      </footer>
    </main>
  );
}
