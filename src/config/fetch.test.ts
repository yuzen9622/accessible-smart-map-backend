import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe("bounded TDX token/retry transport", () => {
  it("settles a stalled shared token refresh within its own five-second timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TDX_CLIENT_ID", "id");
    vi.stubEnv("TDX_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: unknown, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            ),
          ),
      ),
    );
    const { tdxFetch } = await import("./fetch");
    const result = tdxFetch("https://example.invalid").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5100);
    expect(await result).toBeInstanceOf(Error);
  });
  it.each([401, 429])(
    "aborts across HTTP %s retry without issuing a late second request",
    async (status) => {
      vi.useFakeTimers();
      vi.stubEnv("TDX_CLIENT_ID", "id");
      vi.stubEnv("TDX_CLIENT_SECRET", "secret");
      const controller = new AbortController();
      let tokenCount = 0;
      const fetch = vi.fn(async (url: unknown) => {
        if (String(url).includes("openid-connect")) {
          tokenCount++;
          if (tokenCount === 2) return new Promise(() => {});
          return {
            ok: true,
            json: async () => ({ access_token: "token", expires_in: 3600 }),
          };
        }
        return { status };
      });
      vi.stubGlobal("fetch", fetch);
      const { tdxFetch } = await import("./fetch");
      const result = tdxFetch("https://example.invalid", {
        signal: controller.signal,
      }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(1);
      controller.abort(new Error("request deadline"));
      expect((await result).message).toBe("request deadline");
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        fetch.mock.calls.filter(
          ([url]) => String(url) === "https://example.invalid",
        ),
      ).toHaveLength(1);
    },
  );
});
