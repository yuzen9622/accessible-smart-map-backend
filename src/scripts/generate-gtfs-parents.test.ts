import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { addParentStations } from "./generate-gtfs-parents";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtfs-parents-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const STOPS = [
  "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
  "A1,臺中教育大學,24.144755,120.671973,0,",
  "A2,臺中教育大學,24.144800,120.672000,0,",
  "B1,孤站,24.2,120.7,0,",
].join("\n");

describe("addParentStations", () => {
  it("clusters same-name stops and is idempotent across runs", () => {
    const file = path.join(dir, "stops.txt");
    fs.writeFileSync(file, STOPS);

    addParentStations(file);
    const once = fs.readFileSync(file, "utf8");
    addParentStations(file);
    const twice = fs.readFileSync(file, "utf8");

    expect(twice).toBe(once);
    const rows = once.trim().split("\n").slice(1);
    expect(rows.filter((r) => r.startsWith("P_"))).toHaveLength(1);
    expect(rows).toContain("A1,臺中教育大學,24.144755,120.671973,0,P_1");
    expect(rows).toContain("B1,孤站,24.2,120.7,0,");
  });
});
