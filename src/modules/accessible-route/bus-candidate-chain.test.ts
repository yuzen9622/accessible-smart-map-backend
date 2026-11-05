import { describe, expect, it } from "vitest";
import { selectFeasibleBusChain } from "./bus-stop-pair-candidates";
import { candidate } from "./bus-stop-pair-candidates.test";
const start = Date.parse("2026-10-18T08:00:00+08:00");
describe("absolute candidate chain", () => {
  it("solves all candidates, including sixth, and terminal walk", () => {
    const all = [1, 2, 3, 4, 5].map((n) => candidate(String(n), n, 60));
    all.push(candidate("six", 6, 20));
    const chain = selectFeasibleBusChain(
      [
        { type: "BUS", legIndex: 0, minimumBoardingSlackMs: 0 },
        { type: "WALK", durationMs: 120000 },
      ],
      new Map([[0, all]]),
      start,
      "normal",
    );
    expect(chain?.selected.get(0)?.candidateId).toBe("six");
    expect(chain?.arrivalAt).toBe(start + 22 * 60000);
  });
  it("never selects an unreachable transfer", () => {
    const chain = selectFeasibleBusChain(
      [
        { type: "BUS", legIndex: 0, minimumBoardingSlackMs: 0 },
        { type: "WALK", durationMs: 5 * 60000 },
        { type: "BUS", legIndex: 2, minimumBoardingSlackMs: 0 },
      ],
      new Map([
        [0, [candidate("first", 1, 20)]],
        [2, [candidate("missed", 22, 30), candidate("next", 26, 40)]],
      ]),
      start,
      "normal",
    );
    expect(chain?.selected.get(2)?.candidateId).toBe("next");
  });
  const lowFloorChoice = (
    lowAlightMin: number,
    mode: "wheelchair" | "elderly" | "normal",
  ) =>
    selectFeasibleBusChain(
      [{ type: "BUS", legIndex: 0, minimumBoardingSlackMs: 0 }],
      new Map([
        [
          0,
          [
            candidate("unknown", 1, 10),
            candidate("low", 2, lowAlightMin, "low_floor"),
          ],
        ],
      ]),
      start,
      mode,
    )?.selected.get(0)?.candidateId;
  it("waits for a low-floor bus only within the mode's credit", () => {
    // Wheelchair credits 10 min, elderly 5 min, normal nothing.
    expect(lowFloorChoice(19, "wheelchair")).toBe("low");
    expect(lowFloorChoice(21, "wheelchair")).toBe("unknown");
    expect(lowFloorChoice(40, "wheelchair")).toBe("unknown");
    expect(lowFloorChoice(14, "elderly")).toBe("low");
    expect(lowFloorChoice(16, "elderly")).toBe("unknown");
    expect(lowFloorChoice(11, "normal")).toBe("unknown");
  });
  it("credits every low-floor boarding of a chain", () => {
    const chain = selectFeasibleBusChain(
      [
        { type: "BUS", legIndex: 0, minimumBoardingSlackMs: 0 },
        { type: "BUS", legIndex: 1, minimumBoardingSlackMs: 0 },
      ],
      new Map([
        [
          0,
          [
            candidate("a-unknown", 1, 10),
            candidate("a-low", 1, 10, "low_floor"),
          ],
        ],
        [
          1,
          [
            candidate("b-unknown", 11, 20),
            candidate("b-low", 12, 29, "low_floor"),
          ],
        ],
      ]),
      start,
      "wheelchair",
    );
    // a-low + b-low arrives 9 min later but earns two 10-min credits.
    expect(chain?.selected.get(0)?.candidateId).toBe("a-low");
    expect(chain?.selected.get(1)?.candidateId).toBe("b-low");
    expect(chain?.lowFloorBoardings).toBe(2);
  });
  it("checks fixed rail absolute departure after bus delay", () => {
    expect(
      selectFeasibleBusChain(
        [
          { type: "BUS", legIndex: 0, minimumBoardingSlackMs: 0 },
          {
            type: "FIXED_TRANSIT",
            legIndex: 1,
            minimumBoardingSlackMs: 0,
            departureAt: start + 19 * 60000,
            arrivalAt: start + 30 * 60000,
          },
        ],
        new Map([[0, [candidate("late", 1, 20)]]]),
        start,
        "normal",
      ),
    ).toBeNull();
  });
});
