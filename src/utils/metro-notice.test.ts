import { describe, expect, it } from "vitest";
import {
  activeElevatorNotices,
  outageNoticeForMetroFacility,
  parseMetroNoticeCsv,
  parseNoticeTimestamp,
  stationOfMetroFacilityName,
  type MetroNoticeRow,
} from "./metro-notice";

const NOW = new Date("2026-10-01T12:00:00+08:00");

function row(
  station: string,
  postedAt: string,
  description: string,
): MetroNoticeRow {
  return { station, line: "板南線", postedAt: new Date(postedAt), description };
}

describe("parseNoticeTimestamp", () => {
  it("reads the compact timestamp as Taipei time", () => {
    expect(parseNoticeTimestamp("20261001T163300")?.toISOString()).toBe(
      "2026-10-01T08:33:00.000Z",
    );
  });

  it("rejects malformed values", () => {
    expect(parseNoticeTimestamp("2026/10/01")).toBeNull();
  });
});

describe("parseMetroNoticeCsv", () => {
  it("parses the published header and rows", () => {
    const rows = parseMetroNoticeCsv(
      "\uFEFF項次,日期時間,路線,車站,說明\r\n1,20261001T163300,板南線,頂埔站,月台電梯暫停使用\r\n",
    );
    expect(rows).toEqual([
      {
        postedAt: new Date("2026-10-01T16:33:00+08:00"),
        line: "板南線",
        station: "頂埔站",
        description: "月台電梯暫停使用",
      },
    ]);
  });

  it("drops rows without a station or a valid timestamp", () => {
    const rows = parseMetroNoticeCsv(
      "項次,日期時間,路線,車站,說明\n1,bad,板南線,頂埔站,電梯維修\n2,20261001T163300,板南線,,電梯維修\n",
    );
    expect(rows).toEqual([]);
  });

  it("returns nothing when the header is not the expected one", () => {
    expect(parseMetroNoticeCsv("a,b,c\n1,2,3\n")).toEqual([]);
  });
});

describe("activeElevatorNotices", () => {
  it("flags a station whose latest notice is an outage", () => {
    const active = activeElevatorNotices(
      [
        row(
          "頂埔站",
          "2026-10-01T09:00:00+08:00",
          "月台電梯暫停使用，進行檢修",
        ),
      ],
      NOW,
    );
    expect(active.get("頂埔")).toMatchObject({
      station: "頂埔",
      keyword: "暫停",
    });
  });

  it("treats a completion notice as resolved", () => {
    const active = activeElevatorNotices(
      [
        row(
          "頂埔站",
          "2026-10-01T09:00:00+08:00",
          "月台電梯電纜更新作業已完成、開放使用",
        ),
      ],
      NOW,
    );
    expect(active.size).toBe(0);
  });

  it("lets a later completion clear an earlier outage", () => {
    const active = activeElevatorNotices(
      [
        row("頂埔站", "2026-09-30T09:00:00+08:00", "月台電梯暫停使用"),
        row(
          "頂埔站",
          "2026-10-01T09:00:00+08:00",
          "月台電梯已完成檢修、開放使用",
        ),
      ],
      NOW,
    );
    expect(active.size).toBe(0);
  });

  it("lets a later outage override an earlier completion", () => {
    const active = activeElevatorNotices(
      [
        row("頂埔站", "2026-09-30T09:00:00+08:00", "月台電梯已恢復使用"),
        row("頂埔站", "2026-10-01T09:00:00+08:00", "月台電梯故障"),
      ],
      NOW,
    );
    expect(active.get("頂埔")?.keyword).toBe("故障");
  });

  it("ignores notices older than 30 days", () => {
    const active = activeElevatorNotices(
      [row("頂埔站", "2026-08-15T09:00:00+08:00", "月台電梯暫停使用")],
      NOW,
    );
    expect(active.size).toBe(0);
  });

  it("ignores notices about other facilities", () => {
    const active = activeElevatorNotices(
      [row("頂埔站", "2026-10-01T09:00:00+08:00", "電扶梯暫停使用")],
      NOW,
    );
    expect(active.size).toBe(0);
  });

  it("ignores an elevator notice that states no outage", () => {
    const active = activeElevatorNotices(
      [row("頂埔站", "2026-10-01T09:00:00+08:00", "電梯位置調整說明")],
      NOW,
    );
    expect(active.size).toBe(0);
  });
});

describe("stationOfMetroFacilityName", () => {
  it("reads the station from exit facility names", () => {
    expect(stationOfMetroFacilityName("動物園站出口電梯1")).toBe("動物園");
    expect(stationOfMetroFacilityName("台北車站 M8 出口電梯")).toBe("臺北");
  });

  it("returns null when no station is named", () => {
    expect(stationOfMetroFacilityName("無障礙坡道")).toBeNull();
  });
});

describe("outageNoticeForMetroFacility", () => {
  const notices = activeElevatorNotices(
    [row("臺北車站", "2026-10-01T09:00:00+08:00", "M8 出口電梯維修中")],
    NOW,
  );

  it("attaches the station notice to that station's elevators", () => {
    expect(
      outageNoticeForMetroFacility(notices, "台北車站 M8 出口電梯"),
    ).toEqual({
      description: "M8 出口電梯維修中",
      postedAt: "2026-10-01T01:00:00.000Z",
    });
  });

  it("never attaches to a ramp or another station", () => {
    expect(
      outageNoticeForMetroFacility(notices, "台北車站 M3 無障礙坡道"),
    ).toBeUndefined();
    expect(
      outageNoticeForMetroFacility(notices, "動物園站出口電梯1"),
    ).toBeUndefined();
  });
});
