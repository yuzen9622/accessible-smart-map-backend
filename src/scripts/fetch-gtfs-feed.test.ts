import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { findGtfsTableProblem, GTFS_REQUIRED_COLUMNS } from "./fetch-gtfs-feed";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtfs-check-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function table(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const levels = GTFS_REQUIRED_COLUMNS["levels.txt"];

describe("findGtfsTableProblem", () => {
  it("accepts a table with the required columns and an id row (BOM header)", async () => {
    const file = table("ok.txt", "﻿level_id,level_index\n540461009,-1\n");
    expect(await findGtfsTableProblem(file, levels)).toBeNull();
  });

  it("rejects a missing file", async () => {
    expect(
      await findGtfsTableProblem(path.join(dir, "absent.txt"), levels),
    ).toBe("missing");
  });

  it("rejects renamed columns", async () => {
    const file = table("renamed.txt", "id,level_index\n1,0\n");
    expect(await findGtfsTableProblem(file, levels)).toBe(
      "missing columns level_id",
    );
  });

  it("rejects a header-only or empty table", async () => {
    expect(
      await findGtfsTableProblem(
        table("header.txt", "level_id,level_index\n"),
        levels,
      ),
    ).toBe("no rows");
    expect(
      await findGtfsTableProblem(
        table("blank-ids.txt", "level_id,level_index\n,0\n"),
        levels,
      ),
    ).toBe("no rows");
    expect(await findGtfsTableProblem(table("empty.txt", ""), levels)).toBe(
      "empty",
    );
  });
});
