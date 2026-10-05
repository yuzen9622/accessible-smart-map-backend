import { describe, expect, it } from "vitest";
import { decodeCsv } from "./taipei-aps.adapter";

describe("decodeCsv", () => {
  it("decodes UTF-8 bytes as UTF-8", () => {
    expect(decodeCsv(new TextEncoder().encode("號誌編號"))).toBe("號誌編號");
  });

  it("falls back to Big5 for the published file", () => {
    const big5 = Uint8Array.from([0xb6, 0xb5, 0xa6, 0xb8]);
    expect(decodeCsv(big5)).toBe("項次");
  });
});
