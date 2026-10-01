import { describe, it, expect } from "vitest";
import {
  formatNextBusTime,
  nextDepartureText,
  resolveStopStatusLabel,
  runsOnWeekday,
} from "./bus-next-departure";
import type { BusFrequency } from "./transit.types";

const at = (hhmm: string, ymd = "2026-10-01") =>
  new Date(`${ymd}T${hhmm}:00+08:00`);

const trip = (time: string, serviceDays = "每日"): BusFrequency => ({
  scheduleType: "trip",
  serviceDays,
  originStopName: "起站",
  originDepartureTime: time,
});

const headway = (
  start: string,
  end: string,
  serviceDays: string,
  min = 7,
  max = 10,
): BusFrequency => ({
  scheduleType: "headway",
  serviceDays,
  start,
  end,
  minHeadwayMins: min,
  maxHeadwayMins: max,
});

describe("runsOnWeekday", () => {
  it("解析 serviceDayLabel 的各種形態", () => {
    expect(runsOnWeekday("每日", 0)).toBe(true);
    expect(runsOnWeekday("", 3)).toBe(true);
    expect(runsOnWeekday("平日", 4)).toBe(true);
    expect(runsOnWeekday("平日", 6)).toBe(false);
    expect(runsOnWeekday("假日", 0)).toBe(true);
    expect(runsOnWeekday("週四", 4)).toBe(true);
    expect(runsOnWeekday("週四", 5)).toBe(false);
  });
});

describe("nextDepartureText", () => {
  const trips = [trip("06:00"), trip("12:00"), trip("22:30")];

  it("班次制：回傳今天稍後的下一班（中途站標起點發車）", () => {
    expect(nextDepartureText(trips, "中途站", false, at("10:00"))).toBe(
      "12:00 起點發車",
    );
    expect(nextDepartureText(trips, "起站", true, at("10:00"))).toBe("12:00");
  });

  it("今天班次都開完了 → 明日第一班", () => {
    expect(nextDepartureText(trips, "中途站", false, at("23:00"))).toBe(
      "明日 06:00 起點發車",
    );
  });

  it("有逐站時刻時用該站的時間且不加起點發車", () => {
    const withStops: BusFrequency[] = [
      {
        ...(trip("08:00") as any),
        stopTimes: [
          { seq: 1, stopName: "起站", arrivalTime: "08:00" },
          { seq: 2, stopName: "中途站", arrivalTime: "08:15" },
        ],
      },
    ];
    expect(nextDepartureText(withStops, "中途站", false, at("07:00"))).toBe(
      "08:15",
    );
  });

  it("依服務日過濾：週四沒班、週五才有 → 明日", () => {
    expect(
      nextDepartureText([trip("09:00", "週五")], "起站", true, at("08:00")),
    ).toBe("明日 09:00");
  });

  it("隔天也沒營運 → 標出星期幾", () => {
    expect(
      nextDepartureText([trip("09:00", "週一")], "起站", true, at("08:00")),
    ).toBe("週一 09:00");
  });

  it("班距制：營運時段內回傳班距，不跳去下一個時段或明天", () => {
    const bands = [
      headway("05:00", "21:00", "週四"),
      headway("21:00", "22:10", "週四", 10, 15),
      headway("05:00", "21:00", "週五"),
    ];
    expect(nextDepartureText(bands, "中途站", false, at("08:58"))).toBe(
      "每 7–10 分一班",
    );
    expect(nextDepartureText(bands, "中途站", false, at("23:00"))).toBe(
      "明日 05:00 起點發車",
    );
  });

  it("班距制：首班前回傳今天的首班", () => {
    expect(
      nextDepartureText(
        [headway("06:00", "22:00", "週四", 30, 30)],
        "起站",
        true,
        at("05:10"),
      ),
    ).toBe("06:00");
  });

  it("沒有班表 → null", () => {
    expect(nextDepartureText([], "起站", true, at("08:00"))).toBeNull();
  });
});

describe("formatNextBusTime", () => {
  it("同日只給時間、隔日加明日", () => {
    const now = at("23:00");
    expect(formatNextBusTime("2026-10-01T23:20:00+08:00", now)).toBe("23:20");
    expect(formatNextBusTime("2026-10-02T05:30:00+08:00", now)).toBe(
      "明日 05:30",
    );
    expect(formatNextBusTime(undefined, now)).toBeNull();
    expect(formatNextBusTime("garbage", now)).toBeNull();
    expect(formatNextBusTime("2026-10-01T22:50:00+08:00", now)).toBeNull();
  });
});

describe("resolveStopStatusLabel", () => {
  const scheduled = () => "明日 06:00 起點發車";

  it("有即時預估時，尚未發車改為正常（台北 N1 常見）", () => {
    expect(
      resolveStopStatusLabel({
        estimateMinutes: 4,
        stopStatus: 1,
        nextBusTime: null,
        scheduled,
      }),
    ).toBe("正常");
  });

  it("尚未發車 / 末班車已過 / 今日未營運 / 無紀錄 都改顯示下一班", () => {
    for (const stopStatus of [1, 3, 4, undefined]) {
      expect(
        resolveStopStatusLabel({
          estimateMinutes: null,
          stopStatus,
          nextBusTime: null,
          scheduled,
        }),
      ).toBe("明日 06:00 起點發車");
    }
  });

  it("TDX 有 NextBusTime 時優先採用", () => {
    expect(
      resolveStopStatusLabel({
        estimateMinutes: null,
        stopStatus: 1,
        nextBusTime: "09:08",
        scheduled,
      }),
    ).toBe("09:08");
  });

  it("交管不停靠維持原狀態", () => {
    expect(
      resolveStopStatusLabel({
        estimateMinutes: null,
        stopStatus: 2,
        nextBusTime: null,
        scheduled,
      }),
    ).toBe("交管不停靠");
  });

  it("連班表都沒有時才保留上游標籤或暫無到站資訊", () => {
    const none = () => null;
    expect(
      resolveStopStatusLabel({
        estimateMinutes: null,
        stopStatus: 1,
        nextBusTime: null,
        scheduled: none,
      }),
    ).toBe("尚未發車");
    expect(
      resolveStopStatusLabel({
        estimateMinutes: null,
        stopStatus: undefined,
        nextBusTime: null,
        scheduled: none,
      }),
    ).toBe("暫無到站資訊");
  });
});
