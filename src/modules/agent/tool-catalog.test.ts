import { describe, expect, it } from "vitest";
import { buildGeminiTools, buildInteractionTools } from "./tool-catalog";

describe("route tools in the shared catalogue", () => {
  it.each(["inspectVenue", "planIndoorRoute", "planAccessibleRoute"])(
    "declares %s with the same rules and parameters to the text agent and the voice Live bridge",
    (name) => {
      const live = buildGeminiTools()[0].functionDeclarations?.find(
        (d) => d.name === name,
      );
      const text = buildInteractionTools().find(
        (t) => "name" in t && t.name === name,
      );
      expect(live?.parametersJsonSchema).toBeDefined();
      expect(live?.description).toBeTruthy();
      expect(text?.description).toEqual(live?.description);
      expect(text && "parameters" in text && text.parameters).toEqual(
        live?.parametersJsonSchema,
      );
    },
  );
});

it("declares the complete travel-mode matrix and preserves accessibility needs on conflicts", () => {
  const live = buildGeminiTools()[0].functionDeclarations?.find(
    (tool) => tool.name === "planAccessibleRoute",
  );
  const schema = live?.parametersJsonSchema as {
    properties: {
      travelMode: { description: string };
      mode: { enum: string[] };
    };
  };
  expect(schema.properties.mode.enum).toEqual([
    "wheelchair",
    "elderly",
    "visual_impaired",
    "normal",
  ]);
  expect(schema.properties.travelMode.description).toContain(
    "transit（大眾運輸）與 walk（步行）支援 normal、wheelchair、elderly、visual_impaired 四種模式",
  );
  expect(schema.properties.travelMode.description).toContain(
    "drive（開車）與 motorcycle（騎機車）僅支援 normal、elderly",
  );
  expect(schema.properties.travelMode.description).toContain(
    "先釐清交通方式與本次通行模式",
  );
  expect(schema.properties.travelMode.description).toContain(
    "不可自行改成 normal、取消 avoidStairs／requireElevator 或修改個人設定",
  );
});
