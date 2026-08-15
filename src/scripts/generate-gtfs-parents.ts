import fs from "fs";
import path from "path";
import { GTFS_DIR } from "../constants/gtfs";

function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const toRad = (val: number) => (val * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  originalLine: string;
  parentId?: string;
}

async function main() {
  const stopsFilePath = path.join(GTFS_DIR, "stops.txt");

  if (!fs.existsSync(stopsFilePath)) {
    throw new Error(`stops.txt not found at ${stopsFilePath}`);
  }

  const content = fs.readFileSync(stopsFilePath, "utf8").replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== "");
  const headerLine = lines[0];
  const headers = headerLine.split(",");

  const idIdx = headers.indexOf("stop_id");
  const nameIdx = headers.indexOf("stop_name");
  const latIdx = headers.indexOf("stop_lat");
  const lonIdx = headers.indexOf("stop_lon");
  let locTypeIdx = headers.indexOf("location_type");
  let parentIdx = headers.indexOf("parent_station");

  if (idIdx === -1 || nameIdx === -1 || latIdx === -1 || lonIdx === -1) {
    throw new Error("Missing required columns in stops.txt");
  }

  // Ensure location_type and parent_station headers exist
  const newHeaders = [...headers];
  if (locTypeIdx === -1) {
    locTypeIdx = newHeaders.length;
    newHeaders.push("location_type");
  }
  if (parentIdx === -1) {
    parentIdx = newHeaders.length;
    newHeaders.push("parent_station");
  }

  const stopsByName: Record<string, Stop[]> = {};
  const allStops: Stop[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parsed: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ',' && !inQuotes) { parsed.push(current); current = ""; }
      else current += char;
    }
    parsed.push(current);

    const id = parsed[idIdx]?.replace(/^"|"$/g, "").trim();
    const name = parsed[nameIdx]?.replace(/^"|"$/g, "").trim();
    const lat = parseFloat(parsed[latIdx]);
    const lon = parseFloat(parsed[lonIdx]);

    if (!id || !name || isNaN(lat) || isNaN(lon)) {
      allStops.push({ id: "", name: "", lat: 0, lon: 0, originalLine: line });
      continue;
    }

    const stop: Stop = { id, name, lat, lon, originalLine: line };
    allStops.push(stop);

    if (!stopsByName[name]) stopsByName[name] = [];
    stopsByName[name].push(stop);
  }

  let parentStationCount = 0;
  const parentStationLines: string[] = [];

  for (const [name, groupStops] of Object.entries(stopsByName)) {
    if (groupStops.length < 2) continue;

    // Simple clustering: finding connected components within 50m
    const visited = new Set<string>();
    
    for (let i = 0; i < groupStops.length; i++) {
      const s = groupStops[i];
      if (visited.has(s.id)) continue;
      
      const cluster: Stop[] = [s];
      visited.add(s.id);
      
      for (let j = i + 1; j < groupStops.length; j++) {
        const other = groupStops[j];
        if (!visited.has(other.id) && getDistanceMeters(s.lat, s.lon, other.lat, other.lon) <= 50) {
          cluster.push(other);
          visited.add(other.id);
        }
      }

      if (cluster.length > 1) {
        parentStationCount++;
        const parentId = `P_${parentStationCount}`;
        const avgLat = cluster.reduce((sum, st) => sum + st.lat, 0) / cluster.length;
        const avgLon = cluster.reduce((sum, st) => sum + st.lon, 0) / cluster.length;
        
        // Update children
        for (const st of cluster) {
          st.parentId = parentId;
        }

        // Generate parent station line
        const parentRow = new Array(newHeaders.length).fill("");
        parentRow[idIdx] = parentId;
        parentRow[nameIdx] = name;
        parentRow[latIdx] = avgLat.toFixed(6);
        parentRow[lonIdx] = avgLon.toFixed(6);
        parentRow[locTypeIdx] = "1"; // Station
        // parent_station stays empty
        parentStationLines.push(parentRow.join(","));
      }
    }
  }

  // Rewrite stops.txt
  const outputLines = [newHeaders.join(",")];
  for (const pLine of parentStationLines) {
    outputLines.push(pLine);
  }

  for (const st of allStops) {
    if (!st.id) {
      // Unparseable line, just write it back (pad with commas if needed)
      outputLines.push(st.originalLine);
      continue;
    }
    
    const parsed: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of st.originalLine) {
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ',' && !inQuotes) { parsed.push(current); current = ""; }
      else current += char;
    }
    parsed.push(current);

    // Pad if new headers were added
    while (parsed.length < newHeaders.length) parsed.push("");

    if (st.parentId) {
      parsed[locTypeIdx] = "0";
      parsed[parentIdx] = st.parentId;
    } else {
      // If it doesn't have a parent, ensure location_type is 0 (or empty, which implies 0)
      if (!parsed[locTypeIdx]) parsed[locTypeIdx] = "0";
    }

    outputLines.push(parsed.join(","));
  }

  fs.writeFileSync(stopsFilePath, outputLines.join("\n") + "\n", "utf8");
  console.log(`Generated ${parentStationCount} parent stations and updated stops.txt`);
}

main().catch(console.error);
