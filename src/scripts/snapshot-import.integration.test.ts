import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import mongoose from "mongoose";
import Bathroom from "../model/bathroom.model";
import A11y from "../model/a11y.model";
import {
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../tests/helpers/mongo-test-harness";

const fixtures = [
  {
    script: "import-bathrooms",
    source: "data/bathrooms/無障礙廁所.csv",
    sourceCount: 4564,
    collection: Bathroom.collection.name,
    header:
      "county,areacode,village,number,name,address,administration,latitude,longitude,grade,type2,type,exec,diaper",
    row: (n: number) =>
      `65000,65000010,里,F${n},廁所${n},地址,管理單位,25.03,121.51,合格,交通,無障礙廁所,管理人,0`,
    bad: ",,,,,,,,,,,,,",
    schemaBad:
      "65000,65000010,,F1,廁所,地址,管理單位,25.03,121.51,合格,交通,無障礙廁所,管理人,0",
  },
  {
    script: "import-a11y-metro",
    source: "data/metro-a11y/捷運車站出入口無障礙電梯、無障礙坡道GPS座標.csv",
    sourceCount: 190,
    collection: A11y.collection.name,
    header: "項次,出入口電梯/無障礙坡道名稱,出入口編號,經度,緯度",
    row: (n: number) => `${n},車站電梯${n},出口1,121.51,25.03`,
    bad: "1,電梯,出口1,invalid,invalid",
  },
];

describe("snapshot import CLI with isolated MongoDB", () => {
  let mongo: MongoTestContext;
  let directory: string;
  const database = () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error("Missing isolated test database");
    return db;
  };
  beforeAll(async () => {
    mongo = await startMongoTest({ enableTestCommands: true });
    directory = await mkdtemp(join(tmpdir(), "snapshot-import-test-"));
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
    await rm(directory, { recursive: true, force: true });
  });

  async function run(script: string, content: string) {
    const file = join(directory, `${script}.csv`);
    await writeFile(file, content);
    return new Promise<{ code: number | null; output: string }>(
      (resolveResult, reject) => {
        const child = spawn(
          process.execPath,
          [
            "-r",
            "ts-node/register/transpile-only",
            resolve("src/scripts", `${script}.ts`),
            file,
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              DATABASE_URL: mongo.server.getUri(mongo.dbName),
              DOTENV_CONFIG_PATH: "/dev/null",
            },
          },
        );
        let output = "";
        child.stdout.on("data", (data) => {
          output += String(data);
        });
        child.stderr.on("data", (data) => {
          output += String(data);
        });
        child.on("error", reject);
        child.on("close", (code) => resolveResult({ code, output }));
      },
    );
  }

  for (const fixture of fixtures) {
    describe(fixture.script, () => {
      async function seed() {
        const collection = database().collection(fixture.collection);
        await collection.deleteMany({});
        await collection.insertOne({
          sentinel: "previous snapshot",
          nested: { preserve: true },
        });
        await collection.createIndex(
          { sentinel: 1 },
          { name: "operational_index" },
        );
        return { collection, before: await collection.find().toArray() };
      }
      for (const [name, content] of [
        ["empty file", ""],
        ["header-only CSV", `${fixture.header}\n`],
        ["all rows invalid", `${fixture.header}\n${fixture.bad}\n`],
        [
          "wrong header with otherwise valid row",
          `wrong,header\n${fixture.row(1)}\n`,
        ],
      ]) {
        it(`rejects ${name} with nonzero exit and preserves existing documents`, async () => {
          const { collection, before } = await seed();
          const result = await run(fixture.script, content);
          expect(result.code, result.output).toBe(1);
          expect(await collection.find().toArray()).toEqual(before);
        });
      }

      it("keeps the original collection intact when the second batch fails", async () => {
        const { collection, before } = await seed();
        const admin = database().admin();
        await admin.command({
          configureFailPoint: "failCommand",
          mode: { skip: 1 },
          data: { failCommands: ["insert"], errorCode: 2 },
        });
        try {
          const rows = Array.from({ length: 501 }, (_, i) =>
            fixture.row(i + 1),
          );
          const result = await run(
            fixture.script,
            [fixture.header, ...rows].join("\n"),
          );
          expect(result.code, result.output).toBe(1);
          expect(result.output).toContain("failCommand");
          expect(await collection.find().toArray()).toEqual(before);
          const collections = await database().listCollections().toArray();
          expect(
            collections.filter((c) => c.name.includes("_staging_")),
          ).toEqual([]);
        } finally {
          await admin.command({
            configureFailPoint: "failCommand",
            mode: "off",
          });
        }
      });

      it("switches a complete multi-batch snapshot and preserves geo and operational indexes", async () => {
        const { collection } = await seed();
        const rows = Array.from({ length: 501 }, (_, i) => fixture.row(i + 1));
        const result = await run(
          fixture.script,
          [fixture.header, ...rows].join("\n"),
        );
        expect(result.code, result.output).toBe(0);
        expect(await collection.countDocuments()).toBe(501);
        expect(
          await collection.findOne({ sentinel: "previous snapshot" }),
        ).toBeNull();
        const indexes = await collection.indexes();
        expect(indexes.some((index) => index.key.location === "2dsphere")).toBe(
          true,
        );
        expect(
          indexes.some((index) => index.name === "operational_index"),
        ).toBe(true);
      });

      it("imports the checked-in source CSV into the isolated database", async () => {
        const { collection } = await seed();
        const result = await run(
          fixture.script,
          await readFile(fixture.source, "utf-8"),
        );
        expect(result.code, result.output).toBe(0);
        expect(await collection.countDocuments()).toBe(fixture.sourceCount);
      });

      if (fixture.schemaBad)
        it("rejects schema-invalid rows before replacing the snapshot", async () => {
          const { collection, before } = await seed();
          const result = await run(
            fixture.script,
            `${fixture.header}\n${fixture.row(1)}\n${fixture.schemaBad}`,
          );
          expect(result.code, result.output).toBe(1);
          expect(await collection.find().toArray()).toEqual(before);
        });
    });
  }
});
