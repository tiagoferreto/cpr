// Signal processing for chest-compression detection from the vertical
// (gravity-aligned) linear acceleration, in m/s².

export type FilteredSample = { time: number; value: number };

// Compressions happen at ~1.7–2 Hz. The band keeps that range and removes
// gravity-estimate drift (below) and hand tremor / table vibration (above).
const HIGH_PASS_HZ = 0.4;
const LOW_PASS_HZ = 4;

const PEAK_THRESHOLD = 0.8;
const RELEASE_THRESHOLD = -0.5;
const MIN_PEAK_INTERVAL_MS = 360;
const REARM_TIMEOUT_MS = 950;

const MIN_INTERVAL_MS = 360;
const MAX_INTERVAL_MS = 1_100;

export const DEPTH_WINDOW_MS = 1_600;
const MAX_DEPTH_CM = 8.5;

export function median(values: number[]) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** First-order high-pass followed by first-order low-pass, adapted to the actual sample interval. */
export function createBandPass() {
  let lastTime: number | null = null;
  let baseline = 0;
  let output = 0;

  return (time: number, value: number) => {
    if (lastTime === null) {
      lastTime = time;
      baseline = value;
      return 0;
    }
    const dt = Math.min(0.1, Math.max(0.001, (time - lastTime) / 1_000));
    lastTime = time;
    baseline += (1 - Math.exp(-2 * Math.PI * HIGH_PASS_HZ * dt)) * (value - baseline);
    output += (1 - Math.exp(-2 * Math.PI * LOW_PASS_HZ * dt)) * (value - baseline - output);
    return output;
  };
}

/** Amplitude gain of the band-pass at a given frequency, used to undo its attenuation. */
export function bandPassGain(frequencyHz: number) {
  const highPass = frequencyHz / Math.hypot(frequencyHz, HIGH_PASS_HZ);
  const lowPass = 1 / Math.hypot(1, frequencyHz / LOW_PASS_HZ);
  return highPass * lowPass;
}

/**
 * Detects one compression per motion cycle: a local maximum above the peak
 * threshold (the deceleration at the bottom of the stroke), which only counts
 * again once the signal has swung back below the release threshold.
 * Returns the peak time, or null.
 */
export function createCompressionDetector() {
  const recent: FilteredSample[] = [];
  let armed = true;
  let lastPeak = -Infinity;

  return (sample: FilteredSample) => {
    if (sample.value < RELEASE_THRESHOLD) armed = true;
    recent.push(sample);
    if (recent.length > 3) recent.shift();
    if (recent.length < 3) return null;

    const [first, middle, last] = recent;
    const isPeak = middle.value > PEAK_THRESHOLD && middle.value > first.value && middle.value >= last.value;
    const sinceLast = middle.time - lastPeak;
    if (isPeak && sinceLast > MIN_PEAK_INTERVAL_MS && (armed || sinceLast > REARM_TIMEOUT_MS)) {
      armed = false;
      lastPeak = middle.time;
      return middle.time;
    }
    return null;
  };
}

/** Rate in compressions/min from recent peak times, or 0 when there is not enough data. */
export function rateFromTimes(times: number[]) {
  if (times.length < 3) return 0;
  const intervals = times.slice(1).map((time, index) => time - times[index]);
  const valid = intervals.filter((interval) => interval >= MIN_INTERVAL_MS && interval <= MAX_INTERVAL_MS);
  if (valid.length < 2) return 0;
  return Math.round(60_000 / median(valid));
}

/**
 * Peak-to-peak displacement in cm, assuming roughly sinusoidal motion at the
 * compression rate: displacement amplitude = acceleration amplitude / ω².
 */
export function estimateDepth(samples: FilteredSample[], bpm: number) {
  if (samples.length < 12 || bpm < 70) return 0;
  const mean = samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length;
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + (sample.value - mean) ** 2, 0) / samples.length);
  const frequency = bpm / 60;
  const amplitude = (rms * Math.SQRT2) / bandPassGain(frequency);
  const angularFrequency = 2 * Math.PI * frequency;
  const depthCm = ((2 * amplitude) / angularFrequency ** 2) * 100;
  return Math.min(MAX_DEPTH_CM, Math.max(0, depthCm));
}
