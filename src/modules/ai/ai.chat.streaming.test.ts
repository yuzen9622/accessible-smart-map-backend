import http from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

// Only external boundaries are faked. The router, validation, controller,
// runChatAgent, runToolLoop, and compression middleware all run for real.
vi.mock("../../config/ai", () => ({
  googleGenAi: { interactions: { create: vi.fn() } },
  model: "test-model",
}));
vi.mock("./agent-tools", () => ({ executeLocalTool: vi.fn() }));
vi.mock("../agent/tool-catalog", () => ({
  buildInteractionTools: vi.fn(() => [
    { type: "function", name: "getAirQuality" },
    { type: "function", name: "findGooglePlaces" },
    { type: "function", name: "planAccessibleRoute" },
  ]),
}));

import { googleGenAi } from "../../config/ai";
import { executeLocalTool } from "./agent-tools";
import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";

const mockCreate = vi.mocked(googleGenAi.interactions.create);
let server: http.Server;
let url: string;

beforeAll(async () => {
  server = await startTestServer();
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/ai/chat`;
});
afterAll(async () => {
  await stopTestServer(server);
});
beforeEach(() => {
  mockCreate.mockReset();
  vi.mocked(executeLocalTool).mockReset();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function finishDecision() {
  return {
    id: "finish",
    status: "requires_action",
    steps: [
      {
        type: "function_call",
        id: "finish-control",
        name: "finishToolPhase",
        arguments: {},
      },
    ],
  };
}

async function openChat(signal: AbortSignal, question = "空氣如何？") {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip" },
    body: JSON.stringify({
      messages: [{ role: "user", content: question }],
      stream: true,
    }),
    signal,
  });
  if (!response.body) throw new Error("Expected an SSE response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const received = { text: "" };
  const finished = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received.text += decoder.decode(value, { stream: true });
    }
    received.text += decoder.decode();
  })();
  // Mark rejections handled even if a preceding assertion triggers cleanup.
  void finished.catch(() => {});
  return { response, received, finished };
}

it("delivers real SSE tokens before upstream completion, after tool results, without routing prose", async () => {
  const lookupStarted = deferred();
  const finishLookup = deferred();
  const firstConsumed = deferred();
  const finish = deferred();
  async function* answer() {
    yield {
      event_type: "interaction.created",
      interaction: { id: "answer", status: "in_progress" },
    };
    yield {
      event_type: "step.start",
      index: 0,
      step: { type: "model_output" },
    };
    yield {
      event_type: "step.delta",
      index: 0,
      delta: { type: "text", text: "空氣品質" },
    };
    firstConsumed.resolve();
    await finish.promise;
    yield {
      event_type: "step.delta",
      index: 0,
      delta: { type: "text", text: "良好" },
    };
    yield {
      event_type: "interaction.completed",
      interaction: { id: "answer", status: "completed" },
    };
  }
  mockCreate
    .mockResolvedValueOnce({
      id: "tool",
      status: "requires_action",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: "未查先猜空氣很差" }],
        },
        {
          type: "function_call",
          id: "air-call",
          name: "getAirQuality",
          arguments: {},
        },
      ],
    } as never)
    .mockResolvedValueOnce(finishDecision() as never)
    .mockResolvedValueOnce(answer() as never);
  vi.mocked(executeLocalTool).mockImplementationOnce(async () => {
    lookupStarted.resolve();
    await finishLookup.promise;
    return '{"ok":true,"aqi":25}';
  });
  const cancellation = new AbortController();
  let chat: Awaited<ReturnType<typeof openChat>> | undefined;
  try {
    chat = await openChat(cancellation.signal);
    const received = chat.received;
    await lookupStarted.promise;
    await vi.waitFor(() => expect(received.text).toContain("event: tool_call"));
    expect(received.text).not.toMatch(
      /event: tool_result|event: token|event: done|未查先猜/,
    );
    finishLookup.resolve();
    await Promise.race([
      firstConsumed.promise,
      chat.finished.then(() => {
        throw new Error("HTTP response ended before answer streaming");
      }),
    ]);
    await vi.waitFor(() =>
      expect(received.text).toContain(
        'event: token\ndata: {"text":"空氣品質"}',
      ),
    );
    expect(chat.response.status).toBe(200);
    expect(chat.response.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(chat.response.headers.get("content-encoding")).toBeNull();
    expect(chat.response.headers.get("x-accel-buffering")).toBe("no");
    expect(received.text).toContain("event: tool_call");
    expect(received.text).toContain("event: tool_result");
    expect(received.text.indexOf("event: tool_result")).toBeLessThan(
      received.text.indexOf("event: token"),
    );
    expect(received.text).not.toMatch(
      /未查先猜|finishToolPhase|event: done|良好/,
    );
    finish.resolve();
    await chat.finished;
    expect(received.text).toContain('{"text":"良好"}');
    expect(received.text.match(/event: token/g)).toHaveLength(2);
    expect(received.text).toContain("event: done");
    expect(received.text).not.toContain("event: error");
    expect(mockCreate.mock.calls[2][0]).toMatchObject({
      stream: true,
      previous_interaction_id: "finish",
      generation_config: { tool_choice: "none" },
    });
    expect(mockCreate.mock.calls[2][0]).not.toHaveProperty("tools");
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      generation_config: { tool_choice: "any" },
    });
    expect(mockCreate.mock.calls[1][0]).toMatchObject({
      generation_config: { tool_choice: "any" },
      input: [
        expect.objectContaining({ call_id: "air-call", name: "getAirQuality" }),
      ],
    });
    expect(mockCreate.mock.calls[2][0].input).toEqual([
      expect.objectContaining({
        call_id: "finish-control",
        name: "finishToolPhase",
        result: { ready: true },
      }),
    ]);
  } finally {
    finishLookup.resolve();
    finish.resolve();
    cancellation.abort();
    await chat?.finished.catch(() => {});
  }
});

it("performs multi-hop place and route lookups before one streamed accessible-route answer", async () => {
  const decision = (id: string, name: string) => ({
    id,
    status: "requires_action",
    steps: [{ type: "function_call", id: `${id}-call`, name, arguments: {} }],
  });
  const route = {
    ok: true,
    routeContractVersion: 1,
    planId: "plan-taichung",
    selectedRouteId: "accessible-bus",
    routes: [
      {
        routeId: "accessible-bus",
        routeToken: "private-route-capability",
        legs: [
          {
            type: "BUS",
            routeName: "fixture-bus",
            polyline: [
              [120.685, 24.137],
              [120.666, 24.157],
            ],
          },
        ],
      },
    ],
  };
  async function* answer() {
    yield {
      event_type: "interaction.created",
      interaction: { id: "route-answer", status: "in_progress" },
    };
    yield {
      event_type: "step.start",
      index: 0,
      step: { type: "model_output" },
    };
    yield {
      event_type: "step.delta",
      index: 0,
      delta: { type: "text", text: "從台中車站" },
    };
    yield {
      event_type: "step.delta",
      index: 0,
      delta: { type: "text", text: "搭乘無障礙公車。" },
    };
    yield {
      event_type: "interaction.completed",
      interaction: { id: "route-answer", status: "completed" },
    };
  }
  mockCreate
    .mockResolvedValueOnce(decision("place", "findGooglePlaces") as never)
    .mockResolvedValueOnce(decision("route", "planAccessibleRoute") as never)
    .mockResolvedValueOnce(finishDecision() as never)
    .mockResolvedValueOnce(answer() as never);
  vi.mocked(executeLocalTool)
    .mockResolvedValueOnce('{"ok":true,"places":[{"name":"科博館"}]}')
    .mockResolvedValueOnce(JSON.stringify(route));
  const cancellation = new AbortController();
  const chat = await openChat(
    cancellation.signal,
    "幫我規劃從台中車站到科博館的無障礙交通方式。",
  );
  try {
    await chat.finished;
    const events = chat.received.text
      .trim()
      .split("\n\n")
      .map((frame) => frame.split("\n")[0]);
    expect(events).toEqual([
      "event: tool_call",
      "event: tool_result",
      "event: tool_call",
      "event: tool_result",
      "event: token",
      "event: token",
      "event: done",
    ]);
    expect(chat.received.text).toContain("plan-taichung");
    expect(chat.received.text).toContain("private-route-capability");
    expect(chat.received.text).not.toContain("finishToolPhase");
    expect(
      vi.mocked(executeLocalTool).mock.calls.map(([name]) => name),
    ).toEqual(["findGooglePlaces", "planAccessibleRoute"]);
    expect(mockCreate.mock.calls[1][0].input).toEqual([
      expect.objectContaining({
        call_id: "place-call",
        name: "findGooglePlaces",
      }),
    ]);
    expect(mockCreate.mock.calls[2][0].input).toEqual([
      expect.objectContaining({
        call_id: "route-call",
        name: "planAccessibleRoute",
      }),
    ]);
    expect(JSON.stringify(mockCreate.mock.calls[2][0].input)).not.toMatch(
      /polyline|private-route-capability/,
    );
    for (const [params] of mockCreate.mock.calls.slice(0, 3)) {
      expect(params).toMatchObject({
        generation_config: { tool_choice: "any" },
      });
    }
    expect(
      mockCreate.mock.calls.filter(([params]) => params.stream),
    ).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(4);
  } finally {
    cancellation.abort();
  }
});

it("uses the same explicit tool-phase policy for non-streaming chat without exposing its control", async () => {
  mockCreate
    .mockResolvedValueOnce(finishDecision() as never)
    .mockResolvedValueOnce({
      id: "answer",
      status: "completed",
      output_text: "你好",
      steps: [],
    } as never);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "你好" }],
      stream: false,
    }),
  });
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.data.choices[0].message.content).toBe("你好");
  expect(JSON.stringify(body)).not.toContain("finishToolPhase");
  expect(mockCreate.mock.calls[0][0]).toMatchObject({
    generation_config: { tool_choice: "any" },
  });
  expect(mockCreate.mock.calls[1][0]).toMatchObject({
    generation_config: { tool_choice: "none" },
  });
  expect(vi.mocked(executeLocalTool)).not.toHaveBeenCalled();
});

it("surfaces a mid-answer failure as SSE error, without replaying the published prefix", async () => {
  async function* broken() {
    yield {
      event_type: "interaction.created",
      interaction: { id: "broken", status: "in_progress" },
    };
    yield {
      event_type: "step.start",
      index: 0,
      step: { type: "model_output" },
    };
    yield {
      event_type: "step.delta",
      index: 0,
      delta: { type: "text", text: "部分回答" },
    };
    throw Object.assign(new Error("upstream timeout"), { status: 503 });
  }
  mockCreate
    .mockResolvedValueOnce(finishDecision() as never)
    .mockResolvedValueOnce(broken() as never);
  const cancellation = new AbortController();
  const chat = await openChat(cancellation.signal);
  try {
    await chat.finished;
    expect(chat.received.text.match(/event: token/g)).toHaveLength(1);
    expect(chat.received.text).toContain("部分回答");
    expect(chat.received.text).toContain("event: error");
    expect(chat.received.text).toContain("event: done");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  } finally {
    cancellation.abort();
  }
});
