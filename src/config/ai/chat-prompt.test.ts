import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHAT_SYSTEM_PROMPT } from "./chat-prompt";
import { VENUE_ANNOTATION_PRESENTATION_RULE } from "./agent-prompt-shared";

describe("CHAT_SYSTEM_PROMPT byte-identity", () => {
  it("stays byte-identical to the golden captured before the shared-fragment refactor", () => {
    const golden = readFileSync(
      "src/config/ai/__fixtures__/chat-system-prompt.golden.txt",
      "utf8",
    );
    expect(CHAT_SYSTEM_PROMPT).toBe(golden);
  });
});

it("omits editorial annotations in ordinary indoor answers while keeping source-status questions truthful", () => {
  expect(CHAT_SYSTEM_PROMPT).toContain(VENUE_ANNOTATION_PRESENTATION_RULE);
  expect(CHAT_SYSTEM_PROMPT).not.toContain(
    "結果的 wheelchair 為 unknown、slopeMeasured 為 false、heightPending 為 true 時要照實說",
  );
});
