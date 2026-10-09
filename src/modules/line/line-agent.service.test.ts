import { beforeEach, expect, it, vi } from "vitest";
const { runToolLoop, executeLocalTool } = vi.hoisted(() => ({
  runToolLoop: vi.fn(),
  executeLocalTool: vi.fn(),
}));
vi.mock("../agent/agent-manager.service", () => ({ runToolLoop }));
vi.mock("../ai/agent-tools", () => ({ executeLocalTool }));
vi.mock("../../config/ai", () => ({ model: "test-model" }));
vi.mock("../accessible-route/route-token.service", () => ({
  getNavigationEnvelopeByToken: vi.fn(),
}));
import { runLineAgent } from "./line-agent.service";
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
