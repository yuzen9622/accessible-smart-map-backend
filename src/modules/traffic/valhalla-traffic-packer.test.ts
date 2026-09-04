import { describe, expect, it } from "vitest";
import {
  decodeTrafficSpeed,
  decodeTrafficTileHeader,
  encodeTrafficSpeed,
  encodeTrafficTile,
  INDEX_ENTRY_SIZE,
  INVALID_SPEED_RAW,
  MAX_TRAFFIC_SPEED_KPH,
  packTrafficTar,
  pathToTileId,
  readDirectedEdgeCount,
  tileIdToPath,
  TRAFFIC_HEADER_SIZE,
  TRAFFIC_SPEED_SIZE,
  TRAFFIC_VERSION,
  UNKNOWN_TRAFFIC_SPEED_KPH,
  UNKNOWN_TRAFFIC_SPEED_RAW,
} from "./valhalla-traffic-packer";

describe("valhalla-traffic-packer", () => {
  describe("path <-> tileId conversions", () => {
    it("round-trips level 0, 1, and 2 tile paths", () => {
      // Level 0
      const tileIdL0 = 18584; // 0/002/323
      expect(tileIdToPath(tileIdL0)).toBe("0/002/323.gph");
      expect(pathToTileId("0/002/323.gph")).toBe(tileIdL0);

      // Level 1
      const tileIdL1 = 333609; // 1/041/701
      expect(tileIdToPath(tileIdL1)).toBe("1/041/701.gph");
      expect(pathToTileId("1/041/701.gph")).toBe(tileIdL1);

      // Level 2
      const tileIdL2 = 5308850; // 2/000/663/606
      expect(tileIdToPath(tileIdL2)).toBe("2/000/663/606.gph");
      expect(pathToTileId("2/000/663/606.gph")).toBe(tileIdL2);
    });

    it("throws on invalid tile path format", () => {
      expect(() => pathToTileId("invalid-path.gph")).toThrow(
        /Invalid tile path format/,
      );
    });
  });

  describe("readDirectedEdgeCount", () => {
    it("reads directededgecount_ from bytes 40..48 of GraphTile header", () => {
      const buf = Buffer.alloc(64);
      // GraphTile header:
      // nodecount_ (21 bits) = 1000
      // directededgecount_ (21 bits) = 2500
      const nodeCount = 1000n;
      const edgeCount = 2500n;
      const bitfield = nodeCount | (edgeCount << 21n);
      buf.writeBigUInt64LE(bitfield, 40);

      expect(readDirectedEdgeCount(buf)).toBe(2500);
    });

    it("throws when buffer length is under 48 bytes", () => {
      const shortBuf = Buffer.alloc(30);
      expect(() => readDirectedEdgeCount(shortBuf)).toThrow(/Buffer too short/);
    });
  });

  describe("encodeTrafficSpeed & decodeTrafficSpeed", () => {
    it("encodes invalid or unknown speed as INVALID_SPEED_RAW (0x0fffffff)", () => {
      expect(encodeTrafficSpeed(-1)).toBe(INVALID_SPEED_RAW);
      expect(encodeTrafficSpeed(-99)).toBe(INVALID_SPEED_RAW);
      expect(encodeTrafficSpeed(Number.NaN)).toBe(INVALID_SPEED_RAW);
    });

    it("encodes valid speed and correctly decodes bitfield components", () => {
      const tile = encodeTrafficTile(
        5308850,
        1700000000,
        [
          { edgeIndex: 0, speedKmh: 60 },
          { edgeIndex: 1, speedKmh: 0 },
          { edgeIndex: 2, speedKmh: 260 }, // clamped to 252
        ],
        5,
      );

      // Edge 0: 60 km/h -> raw = 30
      const edge0 = decodeTrafficSpeed(tile, 0);
      expect(edge0.isValid).toBe(true);
      expect(edge0.overallEncodedSpeed).toBe(30);
      expect(edge0.speed1).toBe(30);
      expect(edge0.overallSpeedKmh).toBe(60);
      expect(edge0.breakpoint1).toBe(255);
      expect(edge0.breakpoint2).toBe(255);
      expect(edge0.hasIncidents).toBe(false);

      // Edge 1: 0 km/h -> raw = 0 (closed/standstill)
      const edge1 = decodeTrafficSpeed(tile, 1);
      expect(edge1.isValid).toBe(true);
      expect(edge1.overallEncodedSpeed).toBe(0);
      expect(edge1.overallSpeedKmh).toBe(0);
      expect(edge1.breakpoint1).toBe(255);

      // Edge 2: clamped to MAX_TRAFFIC_SPEED_KPH (252) -> raw = 126
      const edge2 = decodeTrafficSpeed(tile, 2);
      expect(edge2.isValid).toBe(true);
      expect(edge2.overallEncodedSpeed).toBe(126);
      expect(edge2.overallSpeedKmh).toBe(MAX_TRAFFIC_SPEED_KPH);

      // Edge 3: unassigned -> INVALID_SPEED_RAW
      const edge3 = decodeTrafficSpeed(tile, 3);
      expect(edge3.isValid).toBe(false);
      expect(edge3.overallEncodedSpeed).toBe(UNKNOWN_TRAFFIC_SPEED_RAW);
      expect(edge3.overallSpeedKmh).toBe(UNKNOWN_TRAFFIC_SPEED_KPH);
      expect(edge3.breakpoint1).toBe(0);
    });

    it("throws RangeError when edgeIndex is out of tile bounds", () => {
      const tile = encodeTrafficTile(100, 1700000000, [], 2);
      expect(() => decodeTrafficSpeed(tile, 5)).toThrow(RangeError);
    });
  });

  describe("encodeTrafficTile", () => {
    it("produces exact 32-byte header with version 3 and accurate sizes", () => {
      const tileId = 5308850;
      const lastUpdate = 1720000000;
      const totalEdges = 10;
      const tile = encodeTrafficTile(tileId, lastUpdate, [], totalEdges);

      expect(tile.length).toBe(
        TRAFFIC_HEADER_SIZE + totalEdges * TRAFFIC_SPEED_SIZE,
      );

      const header = decodeTrafficTileHeader(tile);
      expect(header.tileId).toBe(tileId);
      expect(header.lastUpdateSec).toBe(lastUpdate);
      expect(header.directedEdgeCount).toBe(totalEdges);
      expect(header.trafficTileVersion).toBe(TRAFFIC_VERSION);
      expect(header.spare2).toBe(0);
      expect(header.spare3).toBe(0);
    });
  });

  describe("packTrafficTar", () => {
    it("packages tiles with valid index.bin and ustar tar structure", () => {
      const tileId1 = 18584; // 0/002/323.gph
      const tileId2 = 5308850; // 2/000/663/606.gph

      const tileBuf1 = encodeTrafficTile(
        tileId1,
        1720000000,
        [{ edgeIndex: 0, speedKmh: 50 }],
        4,
      );
      const tileBuf2 = encodeTrafficTile(
        tileId2,
        1720000000,
        [{ edgeIndex: 1, speedKmh: 80 }],
        8,
      );

      const tilesMap = new Map<number, Buffer>([
        [tileId1, tileBuf1],
        [tileId2, tileBuf2],
      ]);

      const tarBuf = packTrafficTar(tilesMap);

      // Must be a multiple of 512 bytes
      expect(tarBuf.length % 512).toBe(0);

      // 1. Verify index.bin tar header at offset 0
      const indexName = tarBuf
        .subarray(0, 100)
        .toString("utf8")
        .replace(/\0.*$/, "");
      expect(indexName).toBe("index.bin");

      const magic = tarBuf.subarray(257, 263).toString("ascii");
      expect(magic).toBe("ustar\0");

      // Checksum validation for index header
      let chksum = 0;
      for (let i = 0; i < 512; i++) {
        if (i >= 148 && i < 156) {
          chksum += 0x20;
        } else {
          chksum += tarBuf[i];
        }
      }
      const recordedChksum = Number.parseInt(
        tarBuf.subarray(148, 154).toString("ascii"),
        8,
      );
      expect(chksum).toBe(recordedChksum);

      // 2. Parse index.bin content (at offset 512)
      const indexData = tarBuf.subarray(512, 512 + 2 * INDEX_ENTRY_SIZE);
      expect(indexData.length).toBe(32);

      // Entry 1
      const entry1Offset = Number(indexData.readBigUInt64LE(0));
      const entry1TileId = indexData.readUInt32LE(8);
      const entry1Size = indexData.readUInt32LE(12);

      expect(entry1TileId).toBe(tileId1);
      expect(entry1Size).toBe(tileBuf1.length);

      // Entry 2
      const entry2Offset = Number(indexData.readBigUInt64LE(16));
      const entry2TileId = indexData.readUInt32LE(24);
      const entry2Size = indexData.readUInt32LE(28);

      expect(entry2TileId).toBe(tileId2);
      expect(entry2Size).toBe(tileBuf2.length);

      // 3. Verify that member data at entry1Offset matches tileBuf1 exactly
      const member1Data = tarBuf.subarray(
        entry1Offset,
        entry1Offset + entry1Size,
      );
      expect(member1Data.equals(tileBuf1)).toBe(true);

      // Verify member1 header immediately precedes its data offset (offset - 512)
      const member1HeaderName = tarBuf
        .subarray(entry1Offset - 512, entry1Offset - 512 + 100)
        .toString("utf8")
        .replace(/\0.*$/, "");
      expect(member1HeaderName).toBe(tileIdToPath(tileId1));

      // 4. Verify member2
      const member2Data = tarBuf.subarray(
        entry2Offset,
        entry2Offset + entry2Size,
      );
      expect(member2Data.equals(tileBuf2)).toBe(true);
      const member2HeaderName = tarBuf
        .subarray(entry2Offset - 512, entry2Offset - 512 + 100)
        .toString("utf8")
        .replace(/\0.*$/, "");
      expect(member2HeaderName).toBe(tileIdToPath(tileId2));

      // 5. Verify decoded speed in unpacked member data
      const decodedEdge0 = decodeTrafficSpeed(member1Data, 0);
      expect(decodedEdge0.overallSpeedKmh).toBe(50);
      expect(decodedEdge0.isValid).toBe(true);

      const decodedEdge1 = decodeTrafficSpeed(member2Data, 1);
      expect(decodedEdge1.overallSpeedKmh).toBe(80);
      expect(decodedEdge1.isValid).toBe(true);

      // 6. Verify end of archive: last 1024 bytes must be 0
      const endMarker = tarBuf.subarray(tarBuf.length - 1024);
      expect(endMarker.every((byte) => byte === 0)).toBe(true);
    });

    it("handles empty tile map cleanly", () => {
      const tarBuf = packTrafficTar(new Map());
      expect(tarBuf.length).toBe(1536); // 512 (index.bin header) + 1024 (end marker)
      const indexName = tarBuf
        .subarray(0, 100)
        .toString("utf8")
        .replace(/\0.*$/, "");
      expect(indexName).toBe("index.bin");
    });
  });
});
