import { describe, it, expect, vi } from "vitest";

const { getRouteByToken } = vi.hoisted(() => ({
  getRouteByToken: vi.fn(),
}));
vi.mock("../accessible-route/route-token.service", () => ({ getRouteByToken }));
import {
  calcBearing,
  calcRelativeDirection,
  degToCompassWord,
  generateNavInstructions,
  generateNavInstructionsFromInput,
  generateNavStepsWithLegIndex,
  nearestPolylineIndex,
  WARN_STEPS_UNAVAILABLE,
  WARN_WALK_STEPS_UNAVAILABLE,
  WARN_ROAD_STEPS_UNAVAILABLE,
} from "./nav-instructions.service";
import type { DriveLeg, MetroLeg, ThsrLeg, WalkLeg } from "../../types/route";

describe("calcBearing", () => {
  it("正北方向應回傳 0", () => {
    expect(calcBearing([0, 0], [0, 1])).toBeCloseTo(0, 1);
  });
  it("正東方向應回傳 90", () => {
    expect(calcBearing([0, 0], [1, 0])).toBeCloseTo(90, 1);
  });
  it("正南方向應回傳 180", () => {
    expect(calcBearing([0, 1], [0, 0])).toBeCloseTo(180, 1);
  });
  it("正西方向應回傳 270", () => {
    expect(calcBearing([1, 0], [0, 0])).toBeCloseTo(270, 1);
  });
  it("台北車站 → 忠孝復興 大致往東", () => {
    const b = calcBearing([121.5173, 25.0478], [121.5444, 25.0416]);
    expect(b).toBeGreaterThan(80);
    expect(b).toBeLessThan(120);
  });
});

describe("calcRelativeDirection", () => {
  it("heading=0, bearing=0 → 正前方", () => {
    expect(calcRelativeDirection(0, 0)).toBe("正前方");
  });
  it("heading=0, bearing=90 → 右側", () => {
    expect(calcRelativeDirection(0, 90)).toBe("右側");
  });
  it("heading=0, bearing=180 → 正後方", () => {
    expect(calcRelativeDirection(0, 180)).toBe("正後方");
  });
  it("heading=0, bearing=270 → 左側", () => {
    expect(calcRelativeDirection(0, 270)).toBe("左側");
  });
  it("heading=130, bearing=215 → 右側（diff=85，落在 67.5–112.5 區間）", () => {
    expect(calcRelativeDirection(130, 215)).toBe("右側");
  });
  it("heading=130, bearing=175 → 右前方（diff=45，正落在右前方中心）", () => {
    expect(calcRelativeDirection(130, 175)).toBe("右前方");
  });
  it("邊界 diff=337.5 應屬正前方", () => {
    expect(calcRelativeDirection(45, 22.5)).toBe("正前方");
  });
});

describe("degToCompassWord", () => {
  it("0 → 北, 90 → 東, 180 → 南, 270 → 西", () => {
    expect(degToCompassWord(0)).toBe("北");
    expect(degToCompassWord(90)).toBe("東");
    expect(degToCompassWord(180)).toBe("南");
    expect(degToCompassWord(270)).toBe("西");
  });
  it("315 → 西北, 360 折回北", () => {
    expect(degToCompassWord(315)).toBe("西北");
    expect(degToCompassWord(360)).toBe("北");
  });
});

describe("walk geometry helpers", () => {
  it("uses latitude-corrected distance and never searches behind the prior index", () => {
    const polyline: [number, number][] = [
      [0.001, 60],
      [0, 60.0007],
    ];
    expect(nearestPolylineIndex(polyline, [0, 60])).toBe(0);
    expect(nearestPolylineIndex(polyline, [0, 60], 1)).toBe(1);
  });

  it("derives bearing from the next 20 metres of polyline before compass fallback", () => {
    const leg: WalkLeg = {
      type: "WALK",
      from: "A",
      to: "B",
      distanceM: 40,
      minutesEst: 1,
      polyline: [
        [121, 25],
        [121.0003, 25],
        [121.0006, 25],
      ],
      a11yFacilities: [],
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
      restPoints: [],
      steps: [
        {
          relativeDirection: "DEPART",
          absoluteDirection: "NORTH",
          streetName: "測試路",
          bogusName: false,
          area: false,
          stairs: false,
          distanceM: 40,
          location: [121, 25],
        },
      ],
    };
    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions[0].bearing).toBe(90);
  });
});

const walkWithSteps = (): WalkLeg => ({
  type: "WALK",
  from: "出發地",
  to: "捷運台北車站",
  distanceM: 200,
  minutesEst: 3,
  polyline: [
    [121.517, 25.047],
    [121.5173, 25.0478],
    [121.518, 25.048],
  ],
  a11yFacilities: [],
  exitInfo: null,
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown",
  restPoints: [],
  steps: [
    {
      relativeDirection: "DEPART",
      absoluteDirection: "NORTH",
      streetName: "中山南路",
      bogusName: false,
      area: false,
      stairs: false,
      distanceM: 120,
      location: [121.517, 25.047],
    },
    {
      relativeDirection: "RIGHT",
      absoluteDirection: "EAST",
      streetName: "忠孝西路",
      bogusName: false,
      area: false,
      stairs: false,
      distanceM: 80,
      location: [121.518, 25.048],
    },
  ],
});

const metroLeg = (): MetroLeg =>
  ({
    type: "METRO",
    railSystem: "TRTC",
    lineName: "板南線",
    departureStation: "台北車站",
    arrivalStation: "忠孝復興",
    rideMinutes: 8,
    facilityHighlights: ["電梯", "無障礙廁所"],
  }) as unknown as MetroLeg;

const roadLeg = (
  type: "DRIVE" | "MOTORCYCLE",
  modeFallback?: "DRIVE",
): DriveLeg => ({
  type,
  from: { lat: 25.04, lng: 121.56 },
  to: { lat: 25.03, lng: 121.55 },
  distanceM: 5200,
  durationMin: 10,
  polyline: [
    [121.56, 25.04],
    [121.555, 25.035],
    [121.55, 25.03],
  ],
  steps: [
    {
      instruction: "沿信義路出發",
      distanceM: 240,
      durationMin: 1,
      maneuver: "DEPART",
      polyline: [
        [121.56, 25.04],
        [121.555, 25.035],
      ],
    },
    {
      instruction: "左轉進入市府路",
      distanceM: 4960,
      durationMin: 9,
      maneuver: "TURN_LEFT",
      polyline: [
        [121.555, 25.035],
        [121.55, 25.03],
      ],
    },
  ],
  modeFallback,
});

describe("generateNavInstructions", () => {
  it("voice helper preserves source legIndex while public output stays identical", () => {
    const route = { legs: [walkWithSteps(), metroLeg(), walkWithSteps()] };
    const before = generateNavInstructions(route);
    const voice = generateNavStepsWithLegIndex(route);
    const after = generateNavInstructions(route);
    expect(after).toEqual(before);
    expect(voice.ok).toBe(true);
    if (!voice.ok) return;
    expect(
      voice.steps
        .filter((step) => step.instruction.legType === "WALK")
        .map((step) => step.legIndex),
    ).toEqual([0, 0, 2, 2, 2]);
    expect(
      voice.steps
        .filter((step) => step.instruction.legType === "METRO")
        .map((step) => step.legIndex),
    ).toEqual([1, 1]);
  });

  it("純步行（含 steps）回傳 depart + turn + arrive", () => {
    const result = generateNavInstructions({ legs: [walkWithSteps()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { instructions } = result.data;
    expect(instructions[0].type).toBe("depart");
    expect(instructions[0].text).toContain("中山南路");
    expect(instructions[0].text).not.toContain("此路段含樓梯");
    expect(instructions[0].stairs).toBe(false);
    expect(instructions[0].bearing).toBe(19);
    expect(instructions[1].type).toBe("turn");
    expect(instructions[1].text).toContain("向右轉");
    expect(instructions[1].streetName).toBe("忠孝西路");
    expect(instructions[1].bearing).toBe(90);
    expect(instructions.at(-1)?.type).toBe("arrive");
    expect(instructions.at(-1)?.stairs).toBe(false);
    expect(result.data.initialBearing).toBe(19);
    expect(result.data.warnings).toHaveLength(0);
    expect(instructions.map((instruction) => instruction.legIndex)).toEqual([
      0, 0, 0,
    ]);
    expect(
      instructions.map((instruction) => instruction.cumulativeDistanceM),
    ).toEqual([0, 120, 200]);
  });

  it("propagates stairs to navigation output and generates the warning text locally", () => {
    const leg = walkWithSteps();
    leg.steps![1] = {
      ...leg.steps![1],
      stairs: true,
      instruction: "上游不應主導一般轉向文字",
    };

    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions[1]).toMatchObject({
      stairs: true,
      streetName: "忠孝西路",
    });
    expect(result.data.instructions[1].text).toContain("向右轉");
    expect(result.data.instructions[1].text).toContain("此路段含樓梯");
    expect(result.data.instructions[1].text).not.toContain("上游不應主導");
  });

  it("merges only continuation fragments and preserves turns, facilities and exitInfo", () => {
    const leg = walkWithSteps();
    leg.polyline = [
      [121.517, 25.047],
      [121.5171, 25.0471],
      [121.5172, 25.0472],
      [121.5173, 25.0473],
      [121.5174, 25.0474],
    ];
    leg.steps = [
      { ...leg.steps![0], distanceM: 100, location: leg.polyline[0] },
      {
        ...leg.steps![0],
        relativeDirection: "CONTINUE",
        distanceM: 5,
        location: leg.polyline[1],
      },
      {
        ...leg.steps![0],
        relativeDirection: "LEFT",
        distanceM: 5,
        location: leg.polyline[2],
      },
      {
        ...leg.steps![0],
        relativeDirection: "ELEVATOR",
        distanceM: 2,
        location: leg.polyline[3],
        instruction: "請進入電梯",
      },
    ];
    leg.exitInfo = {
      exitName: "M6",
      exitNumber: "M6",
      type: "elevator",
      coords: leg.polyline[4],
    };

    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.instructions.map((instruction) => instruction.type),
    ).toEqual(["depart", "turn", "facility", "facility", "arrive"]);
    expect(result.data.instructions[0].distanceM).toBe(105);
    expect(result.data.instructions[1].text).toContain("向左轉");
    expect(
      result.data.instructions.filter(
        (instruction) => instruction.type === "facility",
      ),
    ).toHaveLength(2);
  });

  it("does not merge consecutive continuation steps when the named street changes", () => {
    const leg = walkWithSteps();
    leg.steps = [
      {
        ...leg.steps![0],
        relativeDirection: "CONTINUE",
        streetName: "中山橋",
        bogusName: false,
        distanceM: 218,
        location: leg.polyline[0],
      },
      {
        ...leg.steps![0],
        relativeDirection: "CONTINUE",
        streetName: "中山北路三段",
        bogusName: false,
        distanceM: 36,
        location: leg.polyline[1],
      },
    ];

    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions.slice(0, 2)).toMatchObject([
      { streetName: "中山橋", distanceM: 218 },
      { streetName: "中山北路三段", distanceM: 36 },
    ]);
  });

  it("keeps different stairs states separate and still merges matching states", () => {
    const leg = walkWithSteps();
    leg.steps = [
      {
        ...leg.steps![0],
        relativeDirection: "CONTINUE",
        stairs: false,
        distanceM: 100,
        location: leg.polyline[0],
      },
      {
        ...leg.steps![0],
        relativeDirection: "CONTINUE",
        stairs: true,
        distanceM: 5,
        location: leg.polyline[1],
      },
      {
        ...leg.steps![0],
        relativeDirection: "CONTINUE",
        stairs: true,
        distanceM: 7,
        location: leg.polyline[2],
      },
    ];

    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions.slice(0, 2)).toMatchObject([
      { stairs: false, distanceM: 100 },
      { stairs: true, distanceM: 12 },
    ]);
  });

  it("splits a long OTP step into polyline-grounded prompts no longer than 300 metres", () => {
    const polyline = Array.from(
      { length: 7 },
      (_, index) => [121.5 + index * 0.002, 25] as [number, number],
    );
    const leg: WalkLeg = {
      type: "WALK",
      from: "A",
      to: "B",
      distanceM: 1201,
      minutesEst: 16,
      polyline,
      a11yFacilities: [],
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
      restPoints: [],
      steps: [
        {
          relativeDirection: "DEPART",
          absoluteDirection: "EAST",
          streetName: "長直路段",
          bogusName: false,
          area: false,
          stairs: true,
          distanceM: 1201,
          location: polyline[0],
        },
      ],
    };

    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prompts = result.data.instructions.filter(
      (instruction) => instruction.type !== "arrive",
    );
    expect(prompts).toHaveLength(5);
    expect(
      prompts.every((instruction) => (instruction.distanceM ?? 0) <= 300),
    ).toBe(true);
    expect(
      prompts.reduce(
        (sum, instruction) => sum + (instruction.distanceM ?? 0),
        0,
      ),
    ).toBe(1201);
    expect(
      prompts
        .slice(1)
        .every((instruction) => instruction.text.includes("繼續直行")),
    ).toBe(true);
    expect(prompts.every((instruction) => instruction.stairs)).toBe(true);
    expect(
      prompts.every((instruction) => instruction.text.includes("此路段含樓梯")),
    ).toBe(true);
  });

  it("reclassifies DEPART on later walk legs and exposes their public leg indexes", () => {
    const result = generateNavInstructions({
      legs: [walkWithSteps(), walkWithSteps()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const secondLeg = result.data.instructions.filter(
      (instruction) => instruction.legIndex === 1,
    );
    expect(secondLeg[0].type).toBe("turn");
    expect(secondLeg[0].text).not.toContain("出發");
    expect(secondLeg.every((instruction) => instruction.legIndex === 1)).toBe(
      true,
    );
  });

  it("步行 + 捷運回傳 transit_board / transit_alight，電梯亮點觸發優先電梯句", () => {
    const result = generateNavInstructions({
      legs: [walkWithSteps(), metroLeg()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const board = result.data.instructions.find(
      (i) => i.type === "transit_board",
    );
    const alight = result.data.instructions.find(
      (i) => i.type === "transit_alight",
    );
    expect(board?.text).toContain("板南線");
    expect(board?.text).toContain("台北捷運");
    expect(board?.text).toContain("請優先使用電梯進站");
    expect(board?.stairs).toBe(false);
    expect(alight?.text).toContain("忠孝復興");
    expect(alight?.stairs).toBe(false);
  });

  it("WalkLeg.exitInfo 為電梯時插入 facility 指引", () => {
    const leg = walkWithSteps();
    leg.exitInfo = {
      exitName: "M6",
      exitNumber: "M6",
      type: "elevator",
      coords: [121.518, 25.048],
    };
    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const facility = result.data.instructions.find(
      (i) => i.type === "facility",
    );
    expect(facility?.text).toContain("電梯");
  });

  it("無 steps 的步行段降級為簡化指引並回報警告", () => {
    const leg: WalkLeg = {
      type: "WALK",
      from: "A",
      to: "B",
      distanceM: 100,
      minutesEst: 2,
      polyline: [
        [121.51, 25.04],
        [121.52, 25.05],
      ],
      a11yFacilities: [],
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
      restPoints: [],
      exitInfo: null,
    };
    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.warnings).toEqual([
      WARN_WALK_STEPS_UNAVAILABLE,
      WARN_STEPS_UNAVAILABLE,
    ]);
    expect(result.data.instructions[0]).toMatchObject({
      type: "depart",
      stairs: false,
    });
  });

  it("DRIVE guidance 轉成 depart + turn + arrive", () => {
    const result = generateNavInstructions({ legs: [roadLeg("DRIVE")] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions.map((i) => i.type)).toEqual([
      "depart",
      "turn",
      "arrive",
    ]);
    expect(result.data.instructions[0]).toMatchObject({
      text: "沿信義路出發",
      legType: "DRIVE",
      distanceM: 240,
      stairs: false,
    });
    expect(result.data.instructions[1]).toMatchObject({
      text: "左轉進入市府路",
      legType: "DRIVE",
      distanceM: 4960,
    });
    expect(result.data.warnings).toEqual([]);
  });

  it.each([
    ["原生 MOTORCYCLE", roadLeg("MOTORCYCLE")],
    ["fallback DRIVE 的 MOTORCYCLE", roadLeg("MOTORCYCLE", "DRIVE")],
  ])("%s guidance 保留 MOTORCYCLE legType", (_label, leg) => {
    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions[0].legType).toBe("MOTORCYCLE");
    expect(result.data.instructions.at(-1)?.legType).toBe("MOTORCYCLE");
  });

  it("無 guidance 的 DRIVE 回概略指引並標示降級", () => {
    const leg = roadLeg("DRIVE");
    delete leg.steps;
    const result = generateNavInstructions({ legs: [leg] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.warnings).toContain(WARN_ROAD_STEPS_UNAVAILABLE);
    expect(result.data.instructions[0]).toMatchObject({
      type: "depart",
      legType: "DRIVE",
      distanceM: 5200,
    });
  });

  it("提供 userHeading 時所有含 bearing 步驟填入 relativeDirection", () => {
    const result = generateNavInstructions({ legs: [walkWithSteps()] }, 90);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const ins of result.data.instructions) {
      if (ins.bearing !== null) {
        expect(ins.relativeDirection).not.toBeNull();
      }
    }
  });

  it("未提供 userHeading 時 relativeDirection 全為 null", () => {
    const result = generateNavInstructions({ legs: [walkWithSteps()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const ins of result.data.instructions) {
      expect(ins.relativeDirection).toBeNull();
    }
  });

  it("高鐵段的 transit_board 含車次與發車時間", () => {
    const thsr = {
      type: "THSR",
      trainNo: "0823",
      departureStation: "台北",
      arrivalStation: "台中",
      departureTime: "09:00",
      arrivalTime: "09:48",
      rideMinutes: 48,
    } as unknown as ThsrLeg;
    const result = generateNavInstructions({ legs: [thsr] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const board = result.data.instructions.find(
      (i) => i.type === "transit_board",
    );
    expect(board?.text).toContain("0823");
    expect(board?.text).toContain("09:00");
  });

  it("legs 為空回傳 INVALID_ROUTE_INPUT", () => {
    const result = generateNavInstructions({ legs: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("INVALID_ROUTE_INPUT");
    expect(result.status).toBe(400);
  });

  it("含未支援 leg 型別回傳 UNSUPPORTED_LEG_TYPE", () => {
    const result = generateNavInstructions({ legs: [{ type: "FERRY" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("UNSUPPORTED_LEG_TYPE");
  });

  it("prefers routeToken over an inline route and rejects expired tokens", async () => {
    getRouteByToken.mockResolvedValueOnce({ legs: [walkWithSteps()] });
    const valid = await generateNavInstructionsFromInput({
      routeToken: "capability",
      route: { legs: [] },
    });
    expect(getRouteByToken).toHaveBeenCalledWith("capability");
    expect(valid.ok).toBe(true);

    getRouteByToken.mockResolvedValueOnce(null);
    const expired = await generateNavInstructionsFromInput({
      routeToken: "expired",
      route: { legs: [walkWithSteps()] },
    });
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.reason).toBe("INVALID_ROUTE_TOKEN");
    expect(expired.status).toBe(400);
  });

  it("requires either an inline route or routeToken", async () => {
    const valid = await generateNavInstructionsFromInput({});
    expect(valid.ok).toBe(false);
  });
});
