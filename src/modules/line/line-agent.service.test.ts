import { beforeEach, expect, it, vi } from "vitest";
const { runToolLoop, executeLocalTool } = vi.hoisted(() => ({
  runToolLoop: vi.fn(),
  executeLocalTool: vi.fn(),
}));
vi.mock("../agent/agent-manager.service", () => ({ runToolLoop }));
vi.mock("../ai/agent-tools", () => ({ executeLocalTool }));
vi.mock("../../config/ai", () => ({ model: "test-model" }));
vi.mock("./line-memory", () => ({
  getLineLastRouteToken: vi.fn(),
  setLineLastRouteToken: vi.fn(),
  clearLineLastRouteToken: vi.fn(),
}));
vi.mock("../accessible-route/route-token.service", () => ({
  getNavigationEnvelopeByToken: vi.fn(),
}));
import { runLineAgent } from "./line-agent.service";
import { getLineLastRouteToken, setLineLastRouteToken } from "./line-memory";
beforeEach(() => vi.resetAllMocks());
it("keeps the planned route token for follow-up instructions while preserving LINE authorization context", async () => {
  const plan = {
    ok: true,
    selectedRouteId: "bus",
    routes: [
      {
        routeId: "bus",
        routeToken: "trusted",
        legs: [
          {
            type: "BUS",
            polyline: [
              [120, 24],
              [121, 25],
            ],
          },
        ],
      },
    ],
  };
  executeLocalTool
    .mockResolvedValueOnce(JSON.stringify(plan))
    .mockResolvedValueOnce('{"ok":true,"instructions":[]}');
  runToolLoop.mockImplementation(async (...args) => {
    const execute = args[10];
    const output = await execute("planAccessibleRoute", {
      origin: "A",
      destination: "B",
    });
    expect(output.clientResult).toEqual(plan);
    expect(JSON.stringify(output.modelResult)).not.toMatch(
      /polyline|routeToken/,
    );
    await execute("getNavInstructions", {});
    return { text: "搭乘公車", toolResults: [] };
  });
  await expect(
    runLineAgent({
      lineUserId: "line-user",
      messages: [{ role: "user", content: "去車站" }],
    }),
  ).resolves.toMatchObject({ text: "搭乘公車" });
  expect(executeLocalTool.mock.calls[1][4]).toMatchObject({
    lineUserId: "line-user",
    routeToken: "trusted",
  });
});

it("does not read or save shared route context for a turn without a user identity", async () => {
  executeLocalTool.mockResolvedValue(
    JSON.stringify({
      ok: true,
      selectedRouteId: "bus",
      routes: [{ routeId: "bus", routeToken: "private-route" }],
    }),
  );
  runToolLoop.mockImplementation(async (...args) => {
    await args[10]("planAccessibleRoute", { origin: "A", destination: "B" });
    return { text: "路線", toolResults: [] };
  });
  await runLineAgent({
    lineUserId: "",
    messages: [{ role: "user", content: "去車站" }],
  });
  expect(getLineLastRouteToken).not.toHaveBeenCalled();
  expect(setLineLastRouteToken).not.toHaveBeenCalled();
});

it("drops every state-changing tool for read-only (voice) turns", async () => {
  runToolLoop.mockResolvedValue({ text: "ok", toolResults: [] });
  await runLineAgent({
    lineUserId: "line-user",
    messages: [{ role: "user", content: "我處理" }],
    readOnly: true,
  });
  const allow: string[] = runToolLoop.mock.calls[0][11].toolAllowList;
  for (const name of [
    "bindEmergencyContactCode",
    "bindLineAccountCode",
    "confirmSosReceived",
    "claimSosEvent",
    "updateSosHandlingStatus",
    "resolveSosEvent",
  ]) {
    expect(allow).not.toContain(name);
  }
  expect(allow).toContain("getActiveSosContext");
});

it("keeps write tools for typed turns", async () => {
  runToolLoop.mockResolvedValue({ text: "ok", toolResults: [] });
  await runLineAgent({
    lineUserId: "line-user",
    messages: [{ role: "user", content: "我處理" }],
  });
  expect(runToolLoop.mock.calls[0][11].toolAllowList).toContain(
    "claimSosEvent",
  );
});
