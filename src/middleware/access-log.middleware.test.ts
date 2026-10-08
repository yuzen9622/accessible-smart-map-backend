import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAccessLogger } from "./access-log.middleware";

function buildApp(lines: string[]) {
  const app = express();
  app.use(createAccessLogger({ write: (line) => lines.push(line) }));
  const router = express.Router();
  router.get("/sessions/:token/public", (_req, res) => {
    res.json({ ok: true });
  });
  router.get("/environment", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/v1/sos", router);
  return app;
}

async function waitForLine(lines: string[]): Promise<string> {
  for (let i = 0; i < 50 && lines.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return lines.join("");
}

describe("access log", () => {
  it("logs the route template, not the path token or query", async () => {
    const lines: string[] = [];
    await request(buildApp(lines))
      .get("/api/v1/sos/sessions/secret-share-token-123/public")
      .query({ lat: "25.0478", lng: "121.5170", token: "query-secret" });

    const output = await waitForLine(lines);
    expect(output).toContain("GET /api/v1/sos/sessions/:token/public 200");
    expect(output).not.toContain("secret-share-token-123");
    expect(output).not.toContain("25.0478");
    expect(output).not.toContain("121.5170");
    expect(output).not.toContain("query-secret");
  });

  it("logs unmatched requests without their URL", async () => {
    const lines: string[] = [];
    await request(buildApp(lines)).get("/nope/secret-path?lat=25.1");

    const output = await waitForLine(lines);
    expect(output).toContain("GET <unmatched> 404");
    expect(output).not.toContain("secret-path");
    expect(output).not.toContain("25.1");
  });
});
