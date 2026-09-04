import {
  FREEWAY_SECTIONS_DATA,
  type StaticFreewaySection,
} from "./freeway-corridor.data";

export interface FreewaySectionMeta {
  readonly sectionId: string;
  readonly roadName: string;
  readonly roadDirection: "S" | "N" | "E" | "W";
  readonly startKm: number;
  readonly endKm: number;
  readonly lengthM: number;
  readonly startName?: string;
  readonly endName?: string;
  readonly startPoint?: readonly [number, number];
  readonly endPoint?: readonly [number, number];
}

export type FreewayDirection = "S" | "N" | "E" | "W";
export type FreewayCorridorKey = `${string}_${FreewayDirection}`;

export interface CorridorConfig {
  readonly roadName: string;
  readonly axis: "NS" | "EW";
  readonly posDir: "S" | "E";
  readonly negDir: "N" | "W";
  readonly aliases: readonly string[];
}

export const CORRIDOR_CONFIGS: readonly CorridorConfig[] = [
  {
    roadName: "國道1號汐止五股高架道路",
    axis: "NS",
    posDir: "S",
    negDir: "N",
    aliases: [
      "汐止五股高架道路",
      "五股楊梅高架道路",
      "汐五高架",
      "五楊高架",
      "1高架",
    ],
  },
  {
    roadName: "國道3甲",
    axis: "EW",
    posDir: "E",
    negDir: "W",
    aliases: ["3甲", "國道3甲", "台北聯絡線"],
  },
  {
    roadName: "國道2甲",
    axis: "EW",
    posDir: "E",
    negDir: "W",
    aliases: ["2甲", "國道2甲", "大園支線"],
  },
  {
    roadName: "國道10號",
    axis: "EW",
    posDir: "E",
    negDir: "W",
    aliases: ["10", "高雄支線", "國道十號", "國道10號"],
  },
  {
    roadName: "臺76線",
    axis: "EW",
    posDir: "E",
    negDir: "W",
    aliases: ["76", "台76", "臺76", "東西向快速公路漢寶草屯線"],
  },
  {
    roadName: "國道8號",
    axis: "EW",
    posDir: "E",
    negDir: "W",
    aliases: ["8", "台南支線", "國道八號", "國道8號"],
  },
  {
    roadName: "國道6號",
    axis: "EW",
    posDir: "E",
    negDir: "W",
    aliases: ["6", "水沙連高速公路", "國道六號", "國道6號", "中橫高"],
  },
  {
    roadName: "國道5號",
    axis: "NS",
    posDir: "S",
    negDir: "N",
    aliases: ["5", "蔣渭水高速公路", "國道五號", "國道5號", "北宜高"],
  },
  {
    roadName: "國道4號",
    axis: "EW",
    posDir: "E",
    negDir: "W",
    aliases: ["4", "國道四號", "國道4號", "台中環線"],
  },
  {
    roadName: "國道3號",
    axis: "NS",
    posDir: "S",
    negDir: "N",
    aliases: ["3", "福爾摩沙高速公路", "國道三號", "國道3號", "二高"],
  },
  {
    roadName: "國道2號",
    axis: "EW",
    posDir: "E",
    negDir: "W",
    aliases: ["2", "國道二號", "國道2號", "機場支線"],
  },
  {
    roadName: "國道1號",
    axis: "NS",
    posDir: "S",
    negDir: "N",
    aliases: ["1", "中山高速公路", "國道一號", "國道1號"],
  },
];

const CONFIG_BY_ROAD = new Map<string, CorridorConfig>(
  CORRIDOR_CONFIGS.map((c) => [c.roadName, c]),
);

export function getCorridorConfig(
  roadName: string,
): CorridorConfig | undefined {
  return CONFIG_BY_ROAD.get(roadName);
}

/**
 * Registry managing linear reference metadata for all Taiwan National Freeway Sections.
 *
 * NOTE on Architecture:
 * This registry implements Linear Referencing / Milepost Referencing.
 * It provides continuous mileage intervals [StartKM, EndKM] and anchor coordinates,
 * but DOES NOT establish a permanent topological Graph Edge ID mapping to Valhalla/OSM.
 */
export class FreewayCorridorRegistry {
  private corridorMap = new Map<
    FreewayCorridorKey,
    readonly FreewaySectionMeta[]
  >();
  private sectionMap = new Map<string, FreewaySectionMeta>();

  constructor(
    sections: readonly StaticFreewaySection[] = FREEWAY_SECTIONS_DATA,
  ) {
    this.initialize(sections);
  }

  private initialize(sections: readonly StaticFreewaySection[]): void {
    const mutableCorridors = new Map<
      FreewayCorridorKey,
      FreewaySectionMeta[]
    >();

    for (const raw of sections) {
      const meta: FreewaySectionMeta = Object.freeze({
        sectionId: raw.sectionId,
        roadName: raw.roadName,
        roadDirection: raw.roadDirection,
        startKm: raw.startKm,
        endKm: raw.endKm,
        lengthM: raw.lengthM,
        startName: raw.startName,
        endName: raw.endName,
        startPoint: raw.startPoint
          ? (Object.freeze([raw.startPoint[0], raw.startPoint[1]]) as readonly [
              number,
              number,
            ])
          : undefined,
        endPoint: raw.endPoint
          ? (Object.freeze([raw.endPoint[0], raw.endPoint[1]]) as readonly [
              number,
              number,
            ])
          : undefined,
      });

      this.sectionMap.set(meta.sectionId, meta);

      const key: FreewayCorridorKey = `${meta.roadName}_${meta.roadDirection}`;
      let list = mutableCorridors.get(key);
      if (!list) {
        list = [];
        mutableCorridors.set(key, list);
      }
      list.push(meta);
    }

    // Sort sections within each corridor strictly along the direction of travel and freeze arrays
    for (const [key, list] of mutableCorridors.entries()) {
      const dir = key.slice(-1) as FreewayDirection;
      if (dir === "S" || dir === "E") {
        // Increasing mileage along route travel direction
        list.sort((a, b) => a.startKm - b.startKm);
      } else {
        // Decreasing mileage along route travel direction
        list.sort((a, b) => b.startKm - a.startKm);
      }
      this.corridorMap.set(key, Object.freeze(list));
    }
  }

  /**
   * Retrieves all sections for a corridor sorted in order of travel.
   * Returns a frozen, read-only array to prevent external mutations.
   */
  public getCorridor(
    roadName: string,
    direction: FreewayDirection,
  ): readonly FreewaySectionMeta[] {
    const key: FreewayCorridorKey = `${roadName}_${direction}`;
    return this.corridorMap.get(key) ?? Object.freeze([]);
  }

  /**
   * Retrieves a section by its unique SectionID.
   */
  public getSection(sectionId: string): FreewaySectionMeta | undefined {
    return this.sectionMap.get(sectionId);
  }

  /**
   * Finds the section that covers a specific kilometer post on the corridor.
   */
  public findSectionByKm(
    roadName: string,
    direction: FreewayDirection,
    km: number,
  ): FreewaySectionMeta | undefined {
    const list = this.getCorridor(roadName, direction);
    if (list.length === 0) return undefined;

    const isIncreasing = direction === "S" || direction === "E";

    for (let i = 0; i < list.length; i++) {
      const sec = list[i];
      const isLast = i === list.length - 1;

      if (isIncreasing) {
        // Mileage increases (e.g. 0K -> 1.1K)
        if (km >= sec.startKm && (isLast ? km <= sec.endKm : km < sec.endKm)) {
          return sec;
        }
      } else {
        // Mileage decreases (e.g. 95.4K -> 91.0K)
        if (km <= sec.startKm && (isLast ? km >= sec.endKm : km > sec.endKm)) {
          return sec;
        }
      }
    }

    return undefined;
  }

  public getAllCorridorKeys(): FreewayCorridorKey[] {
    return Array.from(this.corridorMap.keys());
  }

  public get totalSections(): number {
    return this.sectionMap.size;
  }
}

let defaultRegistryInstance: FreewayCorridorRegistry | null = null;

export function getFreewayCorridorRegistry(): FreewayCorridorRegistry {
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = new FreewayCorridorRegistry();
  }
  return defaultRegistryInstance;
}
