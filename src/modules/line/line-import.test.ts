import { spawnSync } from "child_process";
import { expect, it } from "vitest";

it.each(["line.service", "line.router"])(
  "loads %s as the first import in a fresh Node process",
  (name) => {
    const result = spawnSync(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        "-e",
        `require('./src/modules/line/${name}'); console.log('loaded'); process.exit(0)`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          REDIS_URL: "",
          GEMINI_API_KEY: "fixture",
          OPENAI_API_KEY: "fixture",
        },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.stderr).not.toContain(".openapi is not a function");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("loaded");
  },
  20_000,
);
