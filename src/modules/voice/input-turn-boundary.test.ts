import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInputTurnBoundary } from "./input-turn-boundary";

function pcm(durationMs: number, amplitude = 0): Buffer {
  const bytes = Buffer.alloc(durationMs * 32);
  for (let offset = 0; offset < bytes.length; offset += 2)
    bytes.writeInt16LE(amplitude, offset);
  return bytes;
}

describe("PCM input turn boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("settles partial text once after continuous real-time quiet without provider finished", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    boundary.transcriptReceived();
    for (let i = 0; i < 12; i++) {
      boundary.audioReceived(pcm(100));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(onSettled).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) {
      boundary.audioReceived(pcm(100));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(onSettled).toHaveBeenCalledTimes(1);
    boundary.dispose();
  });

  it("does not postpone a ready boundary for every ongoing quiet chunk", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    boundary.transcriptReceived();
    boundary.audioReceived(pcm(1200));
    await vi.advanceTimersByTimeAsync(1100);
    boundary.audioReceived(pcm(100));
    await vi.advanceTimersByTimeAsync(99);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("requires elapsed quiet wall time even when a buffered chunk contains enough samples", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    boundary.transcriptReceived();
    boundary.audioReceived(pcm(5000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1199);
    boundary.audioReceived(pcm(1));
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("does not infer quiet from elapsed wall time without sufficient PCM duration", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    boundary.transcriptReceived();
    boundary.audioReceived(pcm(1));
    await vi.advanceTimersByTimeAsync(2000);
    boundary.audioReceived(pcm(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).not.toHaveBeenCalled();
    boundary.dispose();
  });

  it("does not settle when the audio stream stopped arriving", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    boundary.transcriptReceived();
    boundary.audioReceived(pcm(1200));
    await vi.advanceTimersByTimeAsync(1200);
    expect(onSettled).not.toHaveBeenCalled();
    boundary.audioReceived(pcm(100));
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("voiced PCM including negative samples resets pending quiet", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    boundary.transcriptReceived();
    boundary.audioReceived(pcm(1200));
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(100);
      boundary.audioReceived(pcm(100, i % 2 ? -100 : 100));
    }
    expect(onSettled).not.toHaveBeenCalled();
    for (let i = 0; i < 12; i++) {
      boundary.audioReceived(pcm(100));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("a later partial transcript extends text stability while quiet continues", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    boundary.transcriptReceived();
    boundary.audioReceived(pcm(1200));
    await vi.advanceTimersByTimeAsync(1000);
    boundary.transcriptReceived();
    for (let i = 0; i < 11; i++) {
      boundary.audioReceived(pcm(100));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(onSettled).not.toHaveBeenCalled();
    boundary.audioReceived(pcm(100));
    await vi.advanceTimersByTimeAsync(100);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("does not arm on silence or speech without a transcript", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    for (let i = 0; i < 30; i++) {
      boundary.audioReceived(pcm(100, i < 10 ? 500 : 0));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(onSettled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["reset", "dispose"] as const)(
    "%s prevents a late pending callback",
    async (action) => {
      const onSettled = vi.fn();
      const boundary = createInputTurnBoundary({ onSettled });
      boundary.transcriptReceived();
      boundary.audioReceived(pcm(1200));
      await vi.advanceTimersByTimeAsync(1000);
      boundary.audioReceived(pcm(100));
      boundary[action]();
      await vi.advanceTimersByTimeAsync(2000);
      expect(onSettled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      boundary.dispose();
    },
  );

  it("rearms only on a new transcript and dispose remains terminal", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    for (let turn = 0; turn < 2; turn++) {
      boundary.transcriptReceived();
      for (let i = 0; i < 12; i++) {
        boundary.audioReceived(pcm(100));
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(onSettled).toHaveBeenCalledTimes(turn + 1);
    }
    boundary.dispose();
    boundary.transcriptReceived();
    boundary.audioReceived(pcm(2000));
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores malformed or empty frames rather than counting them as quiet", async () => {
    const onSettled = vi.fn();
    const boundary = createInputTurnBoundary({ onSettled });
    boundary.transcriptReceived();
    boundary.audioReceived(Buffer.alloc(0));
    boundary.audioReceived(Buffer.alloc(40001));
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSettled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["transcript", "voiced", "reset", "dispose"] as const)(
    "%s invalidates a settled callback queued by the consumer",
    async (action) => {
      const onSettled = vi.fn();
      const boundary = createInputTurnBoundary({ onSettled });
      boundary.transcriptReceived();
      for (let i = 0; i < 12; i++) {
        boundary.audioReceived(pcm(100));
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(onSettled).toHaveBeenCalledTimes(1);
      const isCurrent = onSettled.mock.calls[0][0] as () => boolean;
      expect(isCurrent()).toBe(true);
      boundary.audioReceived(pcm(100));
      expect(isCurrent()).toBe(true);
      if (action === "transcript") boundary.transcriptReceived();
      else if (action === "voiced") boundary.audioReceived(pcm(100, -200));
      else boundary[action]();
      expect(isCurrent()).toBe(false);
      await vi.advanceTimersByTimeAsync(3000);
      expect(onSettled).toHaveBeenCalledTimes(1);
      boundary.dispose();
    },
  );
});
