import { describe, expect, it } from "vitest";
import {
  OutputSilenceTrimmer,
  filterModelTranscriptPiece,
} from "./live-output-filter";

const CONFIG = {
  maxSilenceMs: 1500,
  speechLevel: 300,
  speechMaxZeroCrossingRate: 0.5,
};

/** PCM16 at 24 kHz: 48 bytes per ms. */
function pcm(ms: number, sample: (i: number) => number): Buffer {
  const buf = Buffer.alloc(ms * 48);
  for (let i = 0; i < ms * 24; i++)
    buf.writeInt16LE(Math.round(sample(i)), i * 2);
  return buf;
}
const speech = (ms: number) =>
  pcm(ms, (i) => 3000 * Math.sin((2 * Math.PI * 200 * i) / 24000));
const silence = (ms: number) => pcm(ms, () => 0);
const hiss = (ms: number) => pcm(ms, (i) => (i % 2 ? 2000 : -2000));

describe("OutputSilenceTrimmer", () => {
  it("reports how much of the turn was speech, kept silence and dropped silence", () => {
    const t = new OutputSilenceTrimmer(CONFIG);
    t.accept(speech(500));
    t.accept(silence(1000));
    expect(t.peek()).toEqual({
      speechMs: 500,
      keptSilenceMs: 1000,
      droppedMs: 0,
    });
    t.accept(silence(1000));
    expect(t.reset()).toEqual({
      speechMs: 500,
      keptSilenceMs: 1000,
      droppedMs: 1000,
    });
    expect(t.reset()).toEqual({ speechMs: 0, keptSilenceMs: 0, droppedMs: 0 });
  });

  it("forwards speech and natural pauses", () => {
    const t = new OutputSilenceTrimmer(CONFIG);
    expect(t.accept(speech(500))).toBe(true);
    expect(t.accept(silence(700))).toBe(true);
    expect(t.accept(speech(500))).toBe(true);
    expect(t.accept(silence(1500))).toBe(true);
  });

  it("drops silence past the limit and resumes on speech", () => {
    const t = new OutputSilenceTrimmer(CONFIG);
    expect(t.accept(speech(500))).toBe(true);
    expect(t.accept(silence(1000))).toBe(true);
    expect(t.accept(silence(1000))).toBe(false);
    expect(t.accept(silence(40_000))).toBe(false);
    expect(t.accept(speech(200))).toBe(true);
  });

  it("treats loud high-frequency hiss as non-speech", () => {
    const t = new OutputSilenceTrimmer(CONFIG);
    expect(t.accept(hiss(1000))).toBe(true);
    expect(t.accept(hiss(1000))).toBe(false);
  });

  it("starts each turn untrimmed after reset", () => {
    const t = new OutputSilenceTrimmer(CONFIG);
    t.accept(silence(2000));
    t.reset();
    expect(t.accept(silence(1000))).toBe(true);
  });
});

describe("filterModelTranscriptPiece", () => {
  it("keeps text and one short punctuation piece after it", () => {
    expect(filterModelTranscriptPiece("", "好的")).toBe("好的");
    expect(filterModelTranscriptPiece("好的", "。")).toBe("。");
    expect(filterModelTranscriptPiece("營業細節", ". . . . . . . .")).toBe(
      ". .",
    );
    expect(filterModelTranscriptPiece("Hello", " ")).toBe(" ");
  });

  it("drops punctuation runs that follow punctuation or open a turn", () => {
    expect(filterModelTranscriptPiece("", "...")).toBeNull();
    expect(filterModelTranscriptPiece("細節。", ". . . .")).toBeNull();
    expect(filterModelTranscriptPiece("細節. .", " . ")).toBeNull();
  });
});
