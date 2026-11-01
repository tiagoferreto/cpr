import { describe, expect, it } from "vitest";
import {
  createBandPass,
  createCompressionDetector,
  DEPTH_WINDOW_MS,
  estimateDepth,
  median,
  rateFromTimes,
  type FilteredSample,
} from "./signal";

type Simulation = { bpm: number; depthCm: number; sampleHz: number; seconds: number; noise?: (t: number) => number };

/** Feeds a sinusoidal compression motion through the same pipeline the app uses. */
function simulate({ bpm, depthCm, sampleHz, seconds, noise = () => 0 }: Simulation) {
  const bandPass = createBandPass();
  const detect = createCompressionDetector();
  const omega = 2 * Math.PI * (bpm / 60);
  const halfDepthM = depthCm / 200;
  const samples: FilteredSample[] = [];
  const peaks: number[] = [];

  for (let i = 0; i <= seconds * sampleHz; i++) {
    const time = (i * 1_000) / sampleHz;
    const t = time / 1_000;
    // Position z = (d/2)·cos(ωt), so acceleration peaks upward at the bottom of each stroke.
    const acceleration = -halfDepthM * omega ** 2 * Math.cos(omega * t) + noise(t);
    const sample = { time, value: bandPass(time, acceleration) };
    samples.push(sample);
    const peak = detect(sample);
    if (peak !== null) peaks.push(peak);
  }
  return { samples, peaks };
}

describe("median", () => {
  it("handles odd, even and empty input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("compression detection", () => {
  it.each([50, 60, 100, 200])("counts one compression per cycle at %i Hz", (sampleHz) => {
    const { peaks } = simulate({ bpm: 110, depthCm: 5, sampleHz, seconds: 20 });
    expect(peaks.length).toBeGreaterThanOrEqual(35);
    expect(peaks.length).toBeLessThanOrEqual(37);
  });

  it("measures the compression rate", () => {
    for (const bpm of [90, 110, 130]) {
      const { peaks } = simulate({ bpm, depthCm: 5, sampleHz: 60, seconds: 10 });
      expect(Math.abs(rateFromTimes(peaks.slice(-9)) - bpm)).toBeLessThanOrEqual(2);
    }
  });

  it("ignores small high-frequency vibration", () => {
    const { peaks } = simulate({
      bpm: 110,
      depthCm: 0,
      sampleHz: 100,
      seconds: 10,
      noise: (t) => 1.5 * Math.sin(2 * Math.PI * 15 * t),
    });
    expect(peaks).toHaveLength(0);
  });

  it("still detects compressions with vibration on top", () => {
    const { peaks } = simulate({
      bpm: 110,
      depthCm: 5,
      sampleHz: 100,
      seconds: 20,
      noise: (t) => 1.5 * Math.sin(2 * Math.PI * 15 * t),
    });
    expect(peaks.length).toBeGreaterThanOrEqual(35);
    expect(peaks.length).toBeLessThanOrEqual(37);
  });
});

describe("rateFromTimes", () => {
  it("needs at least two valid intervals", () => {
    expect(rateFromTimes([0, 545])).toBe(0);
    expect(rateFromTimes([0, 2_000, 4_000])).toBe(0);
    expect(rateFromTimes([0, 500, 1_000])).toBe(120);
  });
});

describe("estimateDepth", () => {
  it.each([3, 5, 6])("recovers a %i cm sinusoidal stroke", (depthCm) => {
    const { samples } = simulate({ bpm: 110, depthCm, sampleHz: 60, seconds: 10 });
    const end = samples[samples.length - 1].time;
    const recent = samples.filter((sample) => sample.time >= end - DEPTH_WINDOW_MS);
    expect(estimateDepth(recent, 110)).toBeCloseTo(depthCm, 0);
  });

  it("returns 0 without enough data", () => {
    expect(estimateDepth([], 110)).toBe(0);
  });
});
