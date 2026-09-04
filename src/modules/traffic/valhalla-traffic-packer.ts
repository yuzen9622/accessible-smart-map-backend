/**
 * Valhalla Native Live Traffic Packer.
 *
 * Implements binary encoding for Valhalla 3.8.2 traffic tiles and archives:
 * 1. `encodeTrafficTile`: builds a `.traffic` binary tile matching C++ `TrafficTileHeader`
 *    (32 bytes) and `TrafficSpeed` (8 bytes bitfield per directed edge) defined in
 *    `valhalla/baldr/traffictile.h`.
 * 2. `packTrafficTar`: packages tiles into `traffic.tar` containing `index.bin` (`<QLL`
 *    struct of uint64 offset, uint32 tile_id, uint32 size) as the first tar member,
 *    matching Valhalla's `valhalla_build_extract.py` and C++ `GraphReader::load_remote_tar_offsets`.
 */

export const TRAFFIC_HEADER_SIZE = 32;
export const TRAFFIC_SPEED_SIZE = 8;
export const TRAFFIC_VERSION = 3;
export const INDEX_ENTRY_SIZE = 16;

/** Bitfield raw value for unknown/invalid speed: overall, s1, s2, s3 all 127, breakpoints 0. */
export const INVALID_SPEED_RAW = 0x0fffffffn;
export const UNKNOWN_TRAFFIC_SPEED_RAW = 127;
export const MAX_TRAFFIC_SPEED_KPH = 252;
export const UNKNOWN_TRAFFIC_SPEED_KPH = 254;

const TAR_BLOCK_SIZE = 512;

export interface EdgeSpeedInput {
  edgeIndex: number;
  speedKmh: number;
}

export interface TrafficTileHeaderDecoded {
  tileId: number;
  lastUpdateSec: number;
  directedEdgeCount: number;
  trafficTileVersion: number;
  spare2: number;
  spare3: number;
}

export interface TrafficSpeedDecoded {
  overallEncodedSpeed: number;
  speed1: number;
  speed2: number;
  speed3: number;
  breakpoint1: number;
  breakpoint2: number;
  congestion1: number;
  congestion2: number;
  congestion3: number;
  hasIncidents: boolean;
  isValid: boolean;
  overallSpeedKmh: number;
}

/**
 * Converts a Valhalla tile ID (numerical GraphId including level) into a standard tile file path.
 * Levels 0 and 1 use a 2-level directory tree (e.g. `1/041/701.gph`).
 * Level 2 uses a 3-level directory tree (e.g. `2/000/663/606.gph`).
 */
export function tileIdToPath(tileId: number): string {
  const level = tileId & 0x7;
  const idx = tileId >> 3;
  if (level === 2) {
    const s = idx.toString().padStart(9, "0");
    return `${level}/${s.slice(0, 3)}/${s.slice(3, 6)}/${s.slice(6, 9)}.gph`;
  }
  const s = idx.toString().padStart(6, "0");
  return `${level}/${s.slice(0, 3)}/${s.slice(3, 6)}.gph`;
}

/**
 * Converts a tile file path (e.g. `2/000/663/606.gph` or `1/041/701.gph`) into numerical tileId.
 */
export function pathToTileId(path: string): number {
  const cleanPath = path.endsWith(".gph") ? path.slice(0, -4) : path;
  const firstSlash = cleanPath.indexOf("/");
  if (firstSlash === -1) {
    throw new Error(`Invalid tile path format: ${path}`);
  }
  const level = Number.parseInt(cleanPath.slice(0, firstSlash), 10);
  const rest = cleanPath.slice(firstSlash + 1).replace(/\//g, "");
  const idx = Number.parseInt(rest, 10);
  return level | (idx << 3);
}

/**
 * Reads the `directededgecount_` from a Valhalla `.gph` tile buffer without parsing the full tile.
 * Offset 40..48 contains the 64-bit bitfield:
 * - nodecount_: 21 bits
 * - directededgecount_: 21 bits (offset 21)
 */
export function readDirectedEdgeCount(gphBuffer: Buffer): number {
  if (gphBuffer.length < 48) {
    throw new Error(
      `Buffer too short for GraphTile header: ${gphBuffer.length} bytes`,
    );
  }
  const bitfield = gphBuffer.readBigUInt64LE(40);
  return Number((bitfield >> 21n) & 0x1fffffn);
}

/**
 * Encodes a 64-bit TrafficSpeed bitfield value.
 *
 * Bitfield layout (64 bits, little-endian):
 * - overall_encoded_speed : 7 (bits 0..6)
 * - encoded_speed1 : 7 (bits 7..13)
 * - encoded_speed2 : 7 (bits 14..20)
 * - encoded_speed3 : 7 (bits 21..27)
 * - breakpoint1 : 8 (bits 28..35)
 * - breakpoint2 : 8 (bits 36..43)
 * - congestion1 : 6 (bits 44..49)
 * - congestion2 : 6 (bits 50..55)
 * - congestion3 : 6 (bits 56..61)
 * - has_incidents : 1 (bit 62)
 * - spare : 1 (bit 63)
 */
export function encodeTrafficSpeed(speedKmh: number): bigint {
  if (speedKmh < 0 || !Number.isFinite(speedKmh) || speedKmh === -99) {
    return INVALID_SPEED_RAW;
  }
  // Clamp speed between 0 and 252 km/h; resolution is 2 km/h (0..126 raw value)
  const clampedSpeed = Math.min(MAX_TRAFFIC_SPEED_KPH, Math.max(0, speedKmh));
  const raw = BigInt(Math.floor(clampedSpeed / 2));
  // Single uniform speed across edge: breakpoint1=255, breakpoint2=255
  return raw | (raw << 7n) | (255n << 28n) | (255n << 36n);
}

/**
 * Decodes a 64-bit TrafficSpeed bitfield at a specific edge index in a traffic tile buffer.
 */
export function decodeTrafficSpeed(
  tileBuffer: Buffer,
  edgeIndex: number,
): TrafficSpeedDecoded {
  const offset = TRAFFIC_HEADER_SIZE + edgeIndex * TRAFFIC_SPEED_SIZE;
  if (offset + TRAFFIC_SPEED_SIZE > tileBuffer.length) {
    throw new RangeError(
      `edgeIndex ${edgeIndex} out of bounds for buffer length ${tileBuffer.length}`,
    );
  }
  const val = tileBuffer.readBigUInt64LE(offset);
  const overallEncodedSpeed = Number(val & 0x7fn);
  const speed1 = Number((val >> 7n) & 0x7fn);
  const speed2 = Number((val >> 14n) & 0x7fn);
  const speed3 = Number((val >> 21n) & 0x7fn);
  const breakpoint1 = Number((val >> 28n) & 0xffn);
  const breakpoint2 = Number((val >> 36n) & 0xffn);
  const congestion1 = Number((val >> 44n) & 0x3fn);
  const congestion2 = Number((val >> 50n) & 0x3fn);
  const congestion3 = Number((val >> 56n) & 0x3fn);
  const hasIncidents = Number((val >> 62n) & 0x1n) === 1;

  const isValid =
    breakpoint1 !== 0 && overallEncodedSpeed !== UNKNOWN_TRAFFIC_SPEED_RAW;
  const overallSpeedKmh = isValid
    ? overallEncodedSpeed * 2
    : UNKNOWN_TRAFFIC_SPEED_KPH;

  return {
    overallEncodedSpeed,
    speed1,
    speed2,
    speed3,
    breakpoint1,
    breakpoint2,
    congestion1,
    congestion2,
    congestion3,
    hasIncidents,
    isValid,
    overallSpeedKmh,
  };
}

/**
 * Decodes the 32-byte TrafficTileHeader from a traffic tile buffer.
 */
export function decodeTrafficTileHeader(
  tileBuffer: Buffer,
): TrafficTileHeaderDecoded {
  if (tileBuffer.length < TRAFFIC_HEADER_SIZE) {
    throw new Error(
      `Buffer too short for TrafficTileHeader: ${tileBuffer.length} bytes`,
    );
  }
  return {
    tileId: Number(tileBuffer.readBigUInt64LE(0)),
    lastUpdateSec: Number(tileBuffer.readBigUInt64LE(8)),
    directedEdgeCount: tileBuffer.readUInt32LE(16),
    trafficTileVersion: tileBuffer.readUInt32LE(20),
    spare2: tileBuffer.readUInt32LE(24),
    spare3: tileBuffer.readUInt32LE(28),
  };
}

/**
 * Serializes a single Valhalla `.traffic` binary tile.
 *
 * @param tileId Valhalla tile ID (includes level and tile index)
 * @param lastUpdateSec POSIX epoch timestamp of live update in seconds
 * @param edges List of edge speeds to update in this tile
 * @param totalEdgeCount Directed edge count of the corresponding graph tile
 */
export function encodeTrafficTile(
  tileId: number,
  lastUpdateSec: number,
  edges: EdgeSpeedInput[],
  totalEdgeCount: number,
): Buffer {
  const totalBytes = TRAFFIC_HEADER_SIZE + totalEdgeCount * TRAFFIC_SPEED_SIZE;
  const buf = Buffer.alloc(totalBytes);

  // 1. Header (32 bytes)
  buf.writeBigUInt64LE(BigInt(tileId), 0);
  buf.writeBigUInt64LE(BigInt(lastUpdateSec), 8);
  buf.writeUInt32LE(totalEdgeCount, 16);
  buf.writeUInt32LE(TRAFFIC_VERSION, 20);
  buf.writeUInt32LE(0, 24);
  buf.writeUInt32LE(0, 28);

  // 2. Default all edge speeds to INVALID_SPEED_RAW
  for (let i = 0; i < totalEdgeCount; i++) {
    buf.writeBigUInt64LE(
      INVALID_SPEED_RAW,
      TRAFFIC_HEADER_SIZE + i * TRAFFIC_SPEED_SIZE,
    );
  }

  // 3. Write specified edge speeds
  for (const edge of edges) {
    if (edge.edgeIndex >= 0 && edge.edgeIndex < totalEdgeCount) {
      const speedVal = encodeTrafficSpeed(edge.speedKmh);
      buf.writeBigUInt64LE(
        speedVal,
        TRAFFIC_HEADER_SIZE + edge.edgeIndex * TRAFFIC_SPEED_SIZE,
      );
    }
  }

  return buf;
}

/**
 * Creates a standard POSIX ustar tar header (512 bytes).
 */
function createTarHeader(name: string, size: number, mtimeSec = 0): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  // 0..99: filename
  header.write(name, 0, Math.min(name.length, 100), "utf8");
  // 100..107: file mode (0000644\0)
  header.write("0000644\0", 100, 8, "ascii");
  // 108..115: uid (0000000\0)
  header.write("0000000\0", 108, 8, "ascii");
  // 116..123: gid (0000000\0)
  header.write("0000000\0", 116, 8, "ascii");
  // 124..135: file size (octal string with trailing space or null)
  const octalSize = size.toString(8).padStart(11, "0") + " ";
  header.write(octalSize, 124, 12, "ascii");
  // 136..147: mtime (octal string with trailing space or null)
  const octalMtime = mtimeSec.toString(8).padStart(11, "0") + " ";
  header.write(octalMtime, 136, 12, "ascii");
  // 148..155: chksum (initialized with spaces for calculation)
  header.fill(0x20, 148, 156);
  // 156: typeflag ('0' = regular file)
  header.write("0", 156, 1, "ascii");
  // 257..262: magic ("ustar\0")
  header.write("ustar\0", 257, 6, "ascii");
  // 263..264: version ("00")
  header.write("00", 263, 2, "ascii");

  // Calculate checksum across entire 512 bytes
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    sum += header[i];
  }
  const octalSum = sum.toString(8).padStart(6, "0") + "\0 ";
  header.write(octalSum, 148, 8, "ascii");

  return header;
}

/**
 * Pads a byte size up to the next TAR_BLOCK_SIZE boundary.
 */
function padToBlock(size: number): number {
  const remainder = size % TAR_BLOCK_SIZE;
  return remainder === 0 ? size : size + (TAR_BLOCK_SIZE - remainder);
}

/**
 * Packages multiple binary `.traffic` tiles into a valid `traffic.tar` archive.
 *
 * Valhalla 3.8.2 tar requirement:
 * 1. The first file in tar must be `index.bin`.
 * 2. Each entry in `index.bin` is a 16-byte record `<QLL`:
 *    - offset (uint64 little-endian): data offset in bytes from tar start
 *    - tile_id (uint32 little-endian): Valhalla tile ID
 *    - size (uint32 little-endian): data size in bytes
 * 3. Each tile member is named after its path (e.g. `2/000/663/606.gph`).
 *
 * @param tiles Map of tileId to serialized traffic tile buffer
 * @returns Buffer containing the entire tar archive
 */
export function packTrafficTar(tiles: Map<number, Buffer>): Buffer {
  const tileList = Array.from(tiles.entries()).sort((a, b) => a[0] - b[0]);
  const tileCount = tileList.length;

  // 1. Calculate size of index.bin
  const indexDataSize = tileCount * INDEX_ENTRY_SIZE;
  const indexPaddedSize = padToBlock(indexDataSize);

  // 2. Compute data offsets for each tile member
  // index.bin header: offset 0..512
  // index.bin data: offset 512..(512 + indexPaddedSize)
  let currentOffset = TAR_BLOCK_SIZE + indexPaddedSize;

  const indexEntries: Array<{ offset: number; tileId: number; size: number }> =
    [];
  const tileMembers: Array<{
    header: Buffer;
    data: Buffer;
    padding: number;
  }> = [];

  for (const [tileId, tileBuf] of tileList) {
    const memberHeader = createTarHeader(tileIdToPath(tileId), tileBuf.length);
    const dataOffset = currentOffset + TAR_BLOCK_SIZE;
    indexEntries.push({
      offset: dataOffset,
      tileId,
      size: tileBuf.length,
    });

    const paddedSize = padToBlock(tileBuf.length);
    const padding = paddedSize - tileBuf.length;

    tileMembers.push({
      header: memberHeader,
      data: tileBuf,
      padding,
    });

    currentOffset += TAR_BLOCK_SIZE + paddedSize;
  }

  // 3. Build index.bin data buffer
  const indexBuf = Buffer.alloc(indexDataSize);
  for (let i = 0; i < tileCount; i++) {
    const entry = indexEntries[i];
    const offsetInIndex = i * INDEX_ENTRY_SIZE;
    indexBuf.writeBigUInt64LE(BigInt(entry.offset), offsetInIndex);
    indexBuf.writeUInt32LE(entry.tileId, offsetInIndex + 8);
    indexBuf.writeUInt32LE(entry.size, offsetInIndex + 12);
  }

  const indexHeader = createTarHeader("index.bin", indexDataSize);
  const indexPadding = indexPaddedSize - indexDataSize;

  // 4. Assemble tar:
  // - index.bin header (512)
  // - index.bin data (indexDataSize)
  // - index.bin padding (indexPadding)
  // - for each tile: header (512) + data + padding
  // - end-of-archive marker: 1024 bytes of zeros
  const chunks: Buffer[] = [];
  chunks.push(indexHeader);
  if (indexDataSize > 0) {
    chunks.push(indexBuf);
    if (indexPadding > 0) {
      chunks.push(Buffer.alloc(indexPadding, 0));
    }
  }

  for (const member of tileMembers) {
    chunks.push(member.header);
    chunks.push(member.data);
    if (member.padding > 0) {
      chunks.push(Buffer.alloc(member.padding, 0));
    }
  }

  // 2 blocks of 512 zeros for end of archive
  chunks.push(Buffer.alloc(1024, 0));

  return Buffer.concat(chunks);
}
