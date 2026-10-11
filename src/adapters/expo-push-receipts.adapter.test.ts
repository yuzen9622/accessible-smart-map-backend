import { afterEach, describe, expect, it, vi } from "vitest";
import { getExpoPushReceipts } from "./expo-push.adapter";
import {
  EXPO_PUSH_RECEIPTS_URL,
  EXPO_PUSH_TIMEOUT_MS,
} from "../constants/push";

const fetchMock = vi.fn();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fetchMock.mockReset();
  delete process.env.EXPO_ACCESS_TOKEN;
});

describe("getExpoPushReceipts", () => {
  it("does not call HTTP for an empty request and omits credentials when unset", async () => {
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.EXPO_ACCESS_TOKEN;
    await expect(getExpoPushReceipts([])).resolves.toEqual({
      receipts: new Map(),
      failedIds: new Set(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(Response.json({ data: {} }));
    await getExpoPushReceipts(["x"]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("preserves successful chunks when another chunk fails", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { t0: { status: "ok" } } }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );
    const result = await getExpoPushReceipts(
      Array.from({ length: 1001 }, (_, i) => `t${i}`),
    );
    expect(result.receipts.get("t0")).toEqual({ status: "ok" });
    expect(result.failedIds).toEqual(new Set(["t1000"]));
  });

  it.each([
    null,
    [],
    { status: "error", details: null },
    { status: "error", details: [] },
    { status: "error", details: "bad" },
    { status: "error", message: 12 },
  ])("leaves malformed receipt %j unresolved", async (raw) => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(Response.json({ data: { t: raw } }));
    const result = await getExpoPushReceipts(["t"]);
    expect(result.receipts.size).toBe(0);
  });

  it("passes the bounded timeout signal to HTTP and handles its abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        setTimeout(
          () => controller.abort(new DOMException("Timeout", "TimeoutError")),
          ms,
        );
        return controller.signal;
      });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        }),
    );
    const pending = getExpoPushReceipts(["t"]);
    expect(timeout).toHaveBeenCalledWith(EXPO_PUSH_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(EXPO_PUSH_TIMEOUT_MS);
    expect((await pending).failedIds).toEqual(new Set(["t"]));
  });

  it("batches at 1000 ids, sends the access token and drops unrequested/malformed entries", async () => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.EXPO_ACCESS_TOKEN = "secret";
    const ids = Array.from({ length: 1001 }, (_, i) => `t${i}`);
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { ids: string[] };
      return Response.json({
        data: {
          [body.ids[0]]: { status: "ok" },
          bad: { status: "ok" },
          [body.ids[1] ?? "x"]: { status: "weird" },
        },
      });
    });
    const { receipts, failedIds } = await getExpoPushReceipts(ids);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(EXPO_PUSH_RECEIPTS_URL);
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body).ids).toHaveLength(1000);
    expect([...receipts.keys()]).toEqual(["t0", "t1000"]);
    expect(failedIds.size).toBe(0);
  });

  it("reports whole chunks as failed on HTTP errors and malformed envelopes", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 503 }));
    expect((await getExpoPushReceipts(["a"])).failedIds).toEqual(
      new Set(["a"]),
    );
    fetchMock.mockResolvedValueOnce(Response.json({ data: [] }));
    expect((await getExpoPushReceipts(["a"])).failedIds).toEqual(
      new Set(["a"]),
    );
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    expect((await getExpoPushReceipts(["a"])).failedIds).toEqual(
      new Set(["a"]),
    );
  });

  it("leaves malformed error details unresolved and keeps valid error codes", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: {
          a: { status: "error", message: "private", details: { error: 5 } },
          b: { status: "error", details: { error: "DeviceNotRegistered" } },
        },
      }),
    );
    const { receipts } = await getExpoPushReceipts(["a", "b"]);
    expect(receipts.has("a")).toBe(false);
    expect(receipts.get("b")).toEqual({
      status: "error",
      errorCode: "DeviceNotRegistered",
    });
  });
});
