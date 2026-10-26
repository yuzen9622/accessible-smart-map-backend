import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  acquireSidewalkArchive,
  readSidewalkCounties,
  SIDEWALK_COUNTIES,
} from "./sidewalk-source.adapter";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sidewalk-adapter-test-"));
  execFileSync("python3", [
    "-c",
    `
import zipfile,json,sys,stat,struct
from pathlib import Path
root=Path(sys.argv[1]);counties=json.loads(sys.argv[2])
for kind in ['valid','missing','duplicate','mixed','unknown','traversal','absolute','drive','backslash','symlink','oversize','crc','encrypted','count','total']:
 p=root/(kind+'.zip')
 with zipfile.ZipFile(p,'w',compression=zipfile.ZIP_DEFLATED) as z:
  for i,c in enumerate(counties):
   if kind=='missing' and i==0:continue
   batch='202605' if kind=='mixed' and i==0 else '202606'
   if kind=='unknown' and i==0:c='未知市'
   name=f'SIDEWALK_{c}_{batch}_WGS84.geojson'
   z.writestr(name,json.dumps({'type':'FeatureCollection','features':[]}))
   if kind=='duplicate' and i==0:z.writestr('nested/'+name,'{}')
  if kind in ['traversal','absolute','drive','backslash']:
   name={'traversal':'../escape','absolute':'/escape','drive':'C:/escape','backslash':'..\\\\escape'}[kind]
   z.writestr(name,'x')
  if kind=='symlink':
   info=zipfile.ZipInfo('link');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(info,'/tmp/escape')
  if kind=='count':
   for i in range(260):z.writestr(str(i),'')
 b=bytearray(p.read_bytes())
 if kind in ['crc','oversize','encrypted','total']:
  offset=b.index(b'PK\\x01\\x02')
  if kind=='crc':struct.pack_into('<I',b,offset+16,0)
  if kind=='oversize':struct.pack_into('<I',b,offset+24,2**31-1)
  if kind=='encrypted':struct.pack_into('<H',b,offset+8,1)
  if kind=='total':
   while offset>=0:
    struct.pack_into('<I',b,offset+24,256*1024*1024)
    offset=b.find(b'PK\\x01\\x02',offset+4)
 p.write_bytes(b)
(root/'notzip.zip').write_text('not a zip')
`,
    dir,
    JSON.stringify(SIDEWALK_COUNTIES),
  ]);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function consume(kind: string) {
  const counties: string[] = [];
  for await (const entry of readSidewalkCounties(path.join(dir, `${kind}.zip`)))
    counties.push(entry.county);
  return counties;
}

describe("bounded verified county ZIP reader", () => {
  it("reads exactly the 22 WGS84 members sequentially", async () => {
    expect(await consume("valid")).toEqual(SIDEWALK_COUNTIES);
  });
  it.each([
    "missing",
    "duplicate",
    "mixed",
    "unknown",
    "traversal",
    "absolute",
    "drive",
    "backslash",
    "symlink",
    "oversize",
    "crc",
    "encrypted",
    "count",
    "total",
    "notzip",
  ])("rejects %s", async (kind) => {
    await expect(consume(kind)).rejects.toThrow();
  });
  it("rejects an actual CRC mismatch, not just metadata sizes", async () => {
    await expect(consume("crc")).rejects.toThrow(/CRC/);
  });
  it("hashes a task-owned local snapshot and cleans only that copy", async () => {
    const archive = await acquireSidewalkArchive({
      zip: path.join(dir, "valid.zip"),
    });
    expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(archive.file)).toEqual(
      await readFile(path.join(dir, "valid.zip")),
    );
    await archive.cleanup();
    await expect(readFile(archive.file)).rejects.toThrow();
    expect(
      (await readFile(path.join(dir, "valid.zip"))).length,
    ).toBeGreaterThan(0);
  });
  it("streams HTTP responses and rejects declared oversized downloads", async () => {
    const bytes = await readFile(path.join(dir, "valid.zip"));
    let oversizedRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/large") {
        oversizedRequests++;
        res.writeHead(200, { "content-length": 300 * 1024 * 1024 });
        res.end();
      } else {
        res.writeHead(200);
        res.end(bytes);
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("no HTTP port");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const archive = await acquireSidewalkArchive({ url });
      expect(await readFile(archive.file)).toEqual(bytes);
      await archive.cleanup();
      await expect(
        acquireSidewalkArchive({ url: `${url}/large` }),
      ).rejects.toThrow(/size/);
      expect(oversizedRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([false, true])(
    "retries interrupted bodies without reusing partial bytes; persistent failure=%s",
    async (persistentFailure) => {
      const bytes = await readFile(path.join(dir, "valid.zip"));
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.writeHead(200, { "content-length": bytes.length });
        if (persistentFailure || requests < 3) {
          res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
          setTimeout(() => res.destroy(), 30);
        } else {
          res.end(bytes);
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("no HTTP port");
        const source = { url: `http://127.0.0.1:${address.port}/source.zip` };
        if (persistentFailure) {
          await expect(acquireSidewalkArchive(source)).rejects.toThrow();
        } else {
          const archive = await acquireSidewalkArchive(source);
          try {
            expect(await readFile(archive.file)).toEqual(bytes);
            expect(archive.sha256).toBe(
              createHash("sha256").update(bytes).digest("hex"),
            );
            const counties: string[] = [];
            for await (const entry of readSidewalkCounties(archive.file))
              counties.push(entry.county);
            expect(counties).toEqual(SIDEWALK_COUNTIES);
          } finally {
            await archive.cleanup();
          }
        }
        expect(requests).toBe(3);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    15_000,
  );

  it("does not retry a permanent HTTP error", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("no HTTP port");
      await expect(
        acquireSidewalkArchive({
          url: `http://127.0.0.1:${address.port}/missing.zip`,
        }),
      ).rejects.toThrow("source download HTTP 404");
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
