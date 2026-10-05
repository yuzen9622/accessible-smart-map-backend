import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("../../config/ai", () => ({
  googleGenAi: { models: { generateContent } },
  model: "test-model",
}));
import { parseRouteIntent } from "./ai.service";
import { RouteIntentSchema } from "../../schemas/route-intent.schema";

beforeEach(() => generateContent.mockReset());
describe("route intent transit preference boundary", () => {
  it.each(["bus", "rail", "metro", "none", undefined, "subway", { bus: true }])(
    "normalizes the structured model preference %j",
    async (value) => {
      generateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    from: "台北車站",
                    to: "板橋車站",
                    mode: "wheelchair",
                    preferences: { transitPreference: value },
                  }),
                },
              ],
            },
          },
        ],
      });
      const intent =
        await parseRouteIntent("我坐輪椅，從台北到板橋，偏好搭火車");
      expect(intent?.preferences.transitPreference).toBe(
        value === "bus" || value === "rail" || value === "metro"
          ? value
          : "none",
      );
      expect(intent?.mode).toBe("wheelchair");
      expect(intent?.preferences.preferElevator).toBe(true);
      expect(RouteIntentSchema.safeParse(intent).success).toBe(true);
    },
  );
});
