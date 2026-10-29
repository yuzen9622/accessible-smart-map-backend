import { describe, expect, it } from "vitest";
import { buildGeminiTools, buildInteractionTools } from "./tool-catalog";

describe("indoor venue tools in the shared catalogue", () => {
  it.each(["inspectVenue", "planIndoorRoute"])(
    "declares %s with the same parameters to the text agent and the voice Live bridge",
    (name) => {
      const live = buildGeminiTools()[0].functionDeclarations?.find(
        (d) => d.name === name,
      );
      const text = buildInteractionTools().find(
        (t) => "name" in t && t.name === name,
      );
      expect(live?.parametersJsonSchema).toBeDefined();
      expect(text && "parameters" in text && text.parameters).toEqual(
        live?.parametersJsonSchema,
      );
    },
  );
});
