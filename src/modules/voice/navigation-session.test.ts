import { describe, expect, it } from "vitest";
import type { AccessibleRoute, WalkLeg } from "../../types/route";
import {
  NavigationSession,
  distanceToPolylineM,
  haversineLngLat,
  MAX_LOOKAHEAD_STEPS,
} from "./navigation-session";

const coord = (lng: number, lat = 25): [number, number] => [lng, lat];

function walkLeg(
  points: [number, number][],
  withSteps = true,
  from = "起點",
  to = "終點",
): WalkLeg {
  return {
    type: "WALK",
    from,
    to,
    distanceM: 100,
    minutesEst: 2,
    polyline: points,
    a11yFacilities: [],
    ...(withSteps
      ? {
          steps: points.map((location, index) => ({
            relativeDirection:
              index === 0 ? "DEPART" : index % 2 === 0 ? "LEFT" : "RIGHT",
            absoluteDirection: null,
            streetName: `道路${index}`,
            bogusName: false,
            area: false,
            distanceM: 20,
            location,
            instruction: `步行指引${index}`,
          })),
        }
      : {}),
  };
}

function route(legs: AccessibleRoute["legs"]): AccessibleRoute {
  return {
    routeId: "r1",
    routeName: "測試路線",
    totalMinutes: 10,
    transferCount: 0,
    legs,
    accessibilityHighlights: [],
  };
}

function bus(points: [number, number][], from = "甲站", to = "乙站") {
  return {
    type: "BUS" as const,
    routeName: "307",
    departureStop: from,
    arrivalStop: to,
    waitInfo: { time: null, source: "unavailable" as const },
    estimatedWaitMinutes: 0,
    direction: 0 as const,
    polyline: points,
    departureStopA11y: [],
    arrivalStopA11y: [],
  };
}

function metro(points: [number, number][], from = "乙站", to = "丙站") {
  return {
    type: "METRO" as const,
    railSystem: "TRTC",
    lineId: "BL",
    lineName: "板南線",
    lineUid: "TRTC-BL",
    departureStation: from,
    arrivalStation: to,
    departureStationUid: "A",
    arrivalStationUid: "B",
    direction: 0 as const,
    stopsCount: 2,
    rideMinutes: 3,
    waitInfo: { time: null, source: "unavailable" as const },
    estimatedWaitMinutes: 0,
    polyline: points,
    departureStationA11y: [],
    arrivalStationA11y: [],
    facilityHighlights: [],
  };
}

const pos = (p: [number, number], accuracy?: number) => ({
  longitude: p[0],
  latitude: p[1],
  ...(accuracy === undefined ? {} : { accuracy }),
});

describe("NavigationSession pure domain state", () => {
  it("returns NO_ROUTE_ARMED without nav.start", () => {
    const effect = new NavigationSession().start();
    expect(effect.ok).toBe(false);
    expect(effect.events).toEqual([
      { type: "nav.error", code: "NO_ROUTE_ARMED", message: "尚未選擇路線" },
    ]);
  });

  it("emits the public nav.start DTO only and waits for a geofence before speaking", () => {
    const start = coord(121);
    const end = coord(121.001);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end])]));
    const effect = nav.start();
    expect(effect.events[0]).toMatchObject({
      type: "nav.start",
      currentStepIndex: 0,
      totalSteps: 3,
    });
    const firstStep = (effect.events[0] as any).steps[0];
    expect(Object.keys(firstStep).sort()).toEqual(
      ["distanceM", "index", "instruction", "isTransit", "legType"].sort(),
    );
    expect(nav.takeNextSpeech()).toBeNull();
    nav.onPosition(pos(start));
    expect(nav.takeNextSpeech()).toBe(
      "沿「道路0」出發，續行約 20 公尺，方位約 90 度（東）",
    );
  });

  it("advances WALK targets, flushes null arrive text, then emits arrived + stop", () => {
    const start = coord(121);
    const end = coord(121.001);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end])]));
    nav.start(pos(start));
    nav.takeNextSpeech();
    nav.onTurnComplete();
    const finish = nav.onPosition(pos(end));
    expect(finish.events.map((event) => event.type)).toEqual([
      "nav.step",
      "nav.arrived",
      "nav.stop",
    ]);
    expect(nav.takeNextSpeech()).toContain("您已抵達目的地");
  });

  it("anchors transit at board/alight points and resumes the following WALK leg", () => {
    const walkStart = coord(121);
    const board = coord(121.001);
    const alight = coord(121.01);
    const destination = coord(121.011);
    const nav = new NavigationSession();
    nav.armRoute(
      route([
        walkLeg([walkStart, board]),
        bus([board, alight]),
        walkLeg([alight, destination], true, "乙站", "終點"),
      ]),
    );
    nav.start(pos(walkStart));
    nav.onPosition(pos(board));
    const boardEffect = nav.onPosition(pos(board));
    expect(
      boardEffect.events.some((event) => event.type === "nav.transit"),
    ).toBe(true);
    const alightEffect = nav.onPosition(pos(alight));
    expect(
      alightEffect.events.some((event) => event.type === "nav.transit"),
    ).toBe(false);
    const walkEffect = nav.onPosition(pos(alight));
    expect(walkEffect.events.some((event) => event.type === "nav.step")).toBe(
      true,
    );
  });

  it("announces consecutive BUS to METRO at the real transfer point", () => {
    const a = coord(121);
    const transfer = coord(121.01);
    const c = coord(121.02);
    const nav = new NavigationSession();
    nav.armRoute(route([bus([a, transfer]), metro([transfer, c])]));
    const start = nav.start(pos(a));
    expect(
      start.events.filter((event) => event.type === "nav.transit"),
    ).toHaveLength(1);
    const atTransfer = nav.onPosition(pos(transfer));
    const transits = atTransfer.events.filter(
      (event) => event.type === "nav.transit",
    ) as any[];
    expect(transits).toHaveLength(1);
    expect(transits[0].leg.mode).toBe("METRO");
    expect(
      atTransfer.events.some((event) => event.type === "nav.arrived"),
    ).toBe(false);
  });

  it("exposes the upcoming/current transit context without route geometry", () => {
    const walkStart = coord(121);
    const board = coord(121.001);
    const alight = coord(121.01);
    const destination = coord(121.011);
    const nav = new NavigationSession();
    nav.armRoute(
      route([
        walkLeg([walkStart, board]),
        bus([board, alight], "甲站", "乙站"),
        walkLeg([alight, destination], true, "乙站", "目的地"),
      ]),
    );

    expect(nav.getConversationContext()).toEqual({ active: false });
    nav.start(pos(walkStart));
    expect(nav.getConversationContext()).toMatchObject({
      active: true,
      destination: "目的地",
      transit: {
        relation: "upcoming",
        mode: "BUS",
        routeName: "307",
        from: "甲站",
        to: "乙站",
        direction: 0,
      },
    });
    expect(nav.getConversationContext()).not.toHaveProperty("polyline");

    nav.onPosition(pos(board));
    nav.onPosition(pos(board));
    expect(nav.getConversationContext().transit?.relation).toBe("current");
    nav.onPosition(pos(alight));
    expect(nav.getConversationContext().transit).toBeUndefined();
  });

  it("suppresses off-route warnings while riding transit", () => {
    const board = coord(121);
    const alight = coord(121.01);
    const far = coord(122, 26);
    const nav = new NavigationSession();
    nav.armRoute(route([bus([board, alight])]));
    nav.start(pos(board));
    for (let i = 0; i < 5; i++) {
      expect(
        nav
          .onPosition(pos(far))
          .events.some((event) => event.type === "nav.offroute"),
      ).toBe(false);
    }
  });

  it("uses capped GPS accuracy to expand a WALK geofence", () => {
    const target = coord(121.0005);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([target, coord(121.001)])]));
    nav.start();
    const roughlyFortyMetresAway = coord(121.0001);
    const effect = nav.onPosition(pos(roughlyFortyMetresAway, 30));
    expect(effect.events.some((event) => event.type === "nav.step")).toBe(true);
  });

  it("synthesizes a terminal geofence for a WALK leg without steps", () => {
    const start = coord(121);
    const end = coord(121.002);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end], false)]));
    const atStart = nav.start(pos(start));
    expect(atStart.events.some((event) => event.type === "nav.arrived")).toBe(
      false,
    );
    const atEnd = nav.onPosition(pos(end));
    expect(atEnd.events.some((event) => event.type === "nav.arrived")).toBe(
      true,
    );
  });

  it("rejects malformed terminal geometry and DRIVE/MOTORCYCLE legs", () => {
    const same = coord(121);
    for (const invalid of [
      route([walkLeg([same, same], false)]),
      route([bus([same]) as any]),
      route([
        {
          type: "DRIVE",
          from: { lat: 25, lng: 121 },
          to: { lat: 25, lng: 122 },
          distanceM: 10,
          durationMin: 1,
          polyline: [same, coord(122)],
        },
      ]),
      route([
        {
          type: "MOTORCYCLE",
          from: { lat: 25, lng: 121 },
          to: { lat: 25, lng: 122 },
          distanceM: 10,
          durationMin: 1,
          polyline: [same, coord(122)],
        },
      ]),
    ]) {
      const nav = new NavigationSession();
      nav.armRoute(invalid);
      const effect = nav.start();
      expect(effect.events[0]).toMatchObject({
        type: "nav.error",
        code: "NAV_ROUTE_INVALID",
      });
      if (
        invalid.legs[0].type === "DRIVE" ||
        invalid.legs[0].type === "MOTORCYCLE"
      ) {
        expect(effect.events[0]).toMatchObject({
          message: "語音逐步導航目前僅支援步行與大眾運輸",
        });
      }
    }
  });

  it("arrives only at the alight point for a transit-only route", () => {
    const board = coord(121);
    const alight = coord(121.01);
    const nav = new NavigationSession();
    nav.armRoute(route([bus([board, alight])]));
    const boarded = nav.start(pos(board));
    expect(boarded.events.some((event) => event.type === "nav.transit")).toBe(
      true,
    );
    expect(boarded.events.some((event) => event.type === "nav.arrived")).toBe(
      false,
    );
    const finished = nav.onPosition(pos(alight));
    expect(finished.events.map((event) => event.type)).toContain("nav.arrived");
    expect(finished.events).toContainEqual({
      type: "nav.stop",
      reason: "arrived",
    });
  });

  it("bounds skip-ahead to MAX_LOOKAHEAD_STEPS and never reaches a nearby loop end in one sample", () => {
    const points = [
      coord(121),
      coord(121.00005),
      coord(121.0001),
      coord(121.00015),
    ];
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg(points)]));
    nav.start();
    const effect = nav.onPosition(pos(points[3]));
    const steps = effect.events.filter(
      (event) => event.type === "nav.step",
    ) as any[];
    expect(steps.at(-1)?.currentStepIndex).toBeLessThanOrEqual(
      MAX_LOOKAHEAD_STEPS - 1,
    );
    expect(effect.events.some((event) => event.type === "nav.arrived")).toBe(
      false,
    );
  });

  it("debounces off-route, recovers, and warns again without warning on one drift sample", () => {
    const start = coord(121);
    const end = coord(121.01);
    const far = coord(122, 26);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end])]));
    nav.start(pos(start));
    expect(
      nav
        .onPosition(pos(far))
        .events.some((event) => event.type === "nav.offroute"),
    ).toBe(false);
    nav.onPosition(pos(far));
    expect(
      nav
        .onPosition(pos(far))
        .events.some((event) => event.type === "nav.offroute"),
    ).toBe(true);
    nav.onPosition(pos(start));
    nav.onPosition(pos(start));
    nav.onPosition(pos(far));
    nav.onPosition(pos(far));
    expect(
      nav
        .onPosition(pos(far))
        .events.some((event) => event.type === "nav.offroute"),
    ).toBe(true);
  });

  it("replays an interrupted whole sentence and merges queue overflow without losing text", () => {
    const start = coord(121);
    const end = coord(121.001);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end])]));
    nav.start(pos(start));
    const first = nav.takeNextSpeech()!;
    for (let i = 0; i < 10; i++) nav.repeatCurrent();
    nav.onInterrupted();
    expect(nav.takeNextSpeech()).toBe(first);
    nav.onTurnComplete();
    const rest: string[] = [];
    let speech: string | null;
    while ((speech = nav.takeNextSpeech())) {
      rest.push(speech);
      nav.onTurnComplete();
    }
    expect(rest.join(" ").split(first).length - 1).toBe(10);
    expect(rest.length).toBeLessThanOrEqual(8);
  });

  it("keeps a terminal geofence when straight fragments are merged", () => {
    const points = [coord(121), coord(121.0005), coord(121.001)];
    const leg = walkLeg(points);
    leg.steps![1].relativeDirection = "CONTINUE";
    leg.steps![2].relativeDirection = "CONTINUE";
    const nav = new NavigationSession();
    nav.armRoute(route([leg]));

    const started = nav.start(pos(points[0]));
    expect(started.events.some((event) => event.type === "nav.arrived")).toBe(
      false,
    );
    const finished = nav.onPosition(pos(points[2]));
    expect(finished.events.some((event) => event.type === "nav.arrived")).toBe(
      true,
    );
  });

  it("keeps active start/stop/cancel idempotent and ignores work after dispose", () => {
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([coord(121), coord(121.001)])]));
    nav.start();
    expect(nav.start().events).toEqual([]);
    expect(nav.stop("user_voice").events).toEqual([
      { type: "nav.stop", reason: "user_voice" },
    ]);
    expect(nav.stop("user_voice").events).toEqual([]);
    nav.dispose();
    expect(nav.onPosition(pos(coord(121))).events).toEqual([]);
  });
});

describe("navigation geometry uses [lng, lat]", () => {
  it("calculates haversine and nearest polyline distance in metres", () => {
    expect(haversineLngLat([121, 25], [121.001, 25])).toBeGreaterThan(90);
    expect(haversineLngLat([121, 25], [121.001, 25])).toBeLessThan(120);
    expect(
      distanceToPolylineM(
        [121.0005, 25],
        [
          [121, 25],
          [121.001, 25],
        ],
      ),
    ).toBeLessThan(1);
  });
});

describe("navigation-session domain purity", () => {
  it("does not import transport or Gemini sessions", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile(new URL("./navigation-session.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/from ["']ws["']/);
    expect(source).not.toContain("@google/genai");
    expect(source).not.toMatch(/import[^;]+\bSession\b/);
  });
});
