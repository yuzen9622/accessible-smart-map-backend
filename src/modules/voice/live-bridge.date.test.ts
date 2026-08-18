import { describe, it, expect, vi, beforeEach } from "vitest";

const { connect } = vi.hoisted(() => ({
  connect: vi.fn(async () => ({ close: vi.fn(), sendRealtimeInput: vi.fn() })),
}));

vi.mock("../../config/ai", () => ({
  googleGenAi: { live: { connect } },
  model: "test-model",
}));

import { createLiveBridge } from "./live-bridge";

function fakeWs(): any {
  return { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("voice live-bridge injects the current date (F23)", () => {
  it("passes a systemInstruction containing the date rule to live.connect", async () => {
    await createLiveBridge({ ws: fakeWs(), userId: "u1" } as any);
    expect(connect).toHaveBeenCalled();
    // connect.mock.calls entries are argument tuples; the first arg carries the
    // `{ config: { systemInstruction } }` payload the bridge passes to live.
    const [config] = connect.mock.calls[0] as unknown as [
      { config: { systemInstruction: string } },
    ];
    expect(config.config.systemInstruction).toContain("【現在時間】");
  });
});
