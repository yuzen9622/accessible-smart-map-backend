import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../adapters/voice-synthesis.adapter", () => ({
  synthesizeVoice: vi.fn(),
}));
import { synthesizeVoice } from "../../adapters/voice-synthesis.adapter";
import { createTrustedSpeech } from "./trusted-speech";
const request = () => ({
  text: "真實導航指示",
  voiceName: "Kore",
  isCurrent: vi.fn(() => true),
  onText: vi.fn(),
  onAudio: vi.fn(() => true),
  onComplete: vi.fn(),
  onFailure: vi.fn(),
});
describe("trusted speech ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());
  it("paces 24k PCM and completes only after its actual duration", async () => {
    vi.mocked(synthesizeVoice).mockResolvedValue({
      pcm: Buffer.alloc(4800, 4),
      sampleRate: 24000,
    });
    const speech = createTrustedSpeech();
    const r = request();
    speech.speak(r);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.onAudio).toHaveBeenCalledTimes(1);
    expect(r.onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99);
    expect(r.onAudio).toHaveBeenCalledTimes(3);
    expect(r.onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.onComplete).toHaveBeenCalledTimes(1);
    expect(speech.busy).toBe(false);
  });
  it("cancels an awaiting synthesis without any late output or completion", async () => {
    let resolve!: (value: { pcm: Buffer; sampleRate: 24000 }) => void;
    vi.mocked(synthesizeVoice).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const speech = createTrustedSpeech();
    const r = request();
    speech.speak(r);
    speech.cancel();
    expect(vi.mocked(synthesizeVoice).mock.calls[0][1].signal.aborted).toBe(
      true,
    );
    resolve({ pcm: Buffer.alloc(4800, 4), sampleRate: 24000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(r.onAudio).not.toHaveBeenCalled();
    expect(r.onText).not.toHaveBeenCalled();
    expect(r.onComplete).not.toHaveBeenCalled();
    expect(r.onFailure).not.toHaveBeenCalled();
  });
  it("cancels playback without sending queued bytes or a late completion", async () => {
    vi.mocked(synthesizeVoice).mockResolvedValue({
      pcm: Buffer.alloc(4800, 4),
      sampleRate: 24000,
    });
    const speech = createTrustedSpeech();
    const r = request();
    speech.speak(r);
    await vi.advanceTimersByTimeAsync(0);
    speech.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.onAudio).toHaveBeenCalledTimes(1);
    expect(r.onComplete).not.toHaveBeenCalled();
    expect(speech.busy).toBe(false);
  });
  it("releases a stale job even if the caller missed explicit cancellation", async () => {
    vi.mocked(synthesizeVoice).mockResolvedValue({
      pcm: Buffer.alloc(4800, 4),
      sampleRate: 24000,
    });
    const speech = createTrustedSpeech();
    const r = request();
    speech.speak(r);
    r.isCurrent.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(speech.busy).toBe(false);
    expect(r.onComplete).not.toHaveBeenCalled();
    expect(r.onFailure).not.toHaveBeenCalled();
  });
  it("reports synthesis or transport failure without pretending a clip completed", async () => {
    vi.mocked(synthesizeVoice).mockRejectedValue(new Error("offline"));
    const speech = createTrustedSpeech();
    const r = request();
    speech.speak(r);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.onFailure).toHaveBeenCalledTimes(1);
    expect(r.onAudio).not.toHaveBeenCalled();
    expect(r.onComplete).not.toHaveBeenCalled();
    vi.mocked(synthesizeVoice).mockResolvedValue({
      pcm: Buffer.alloc(4800, 4),
      sampleRate: 24000,
    });
    const b = request();
    b.onAudio.mockReturnValue(false);
    speech.speak(b);
    await vi.advanceTimersByTimeAsync(100);
    expect(b.onFailure).toHaveBeenCalledTimes(1);
    expect(b.onComplete).not.toHaveBeenCalled();
  });
});
