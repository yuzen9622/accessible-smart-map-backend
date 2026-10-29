import { describe, expect, it } from "vitest";
import { buildGeminiTools, buildInteractionTools } from "./tool-catalog";

describe("inspectVenue in the shared catalogue", () => {
  it("is declared with the same parameters to the text agent and the voice Live bridge", () => {
    const live = buildGeminiTools()[0].functionDeclarations?.find(
      (d) => d.name === "inspectVenue",
    );
    const text = buildInteractionTools().find(
      (t) => "name" in t && t.name === "inspectVenue",
    );
    expect(live?.parametersJsonSchema).toBeDefined();
    expect(text && "parameters" in text && text.parameters).toEqual(
      live?.parametersJsonSchema,
    );
  });
});
