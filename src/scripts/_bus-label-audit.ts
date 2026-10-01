/* eslint-disable */
const fetchMod = require("../config/fetch");
import fs from "fs";
import mongoose from "mongoose";
import BusRouteModel from "../model/bus-route.model";
import {
  getBusRouteDetail,
  getBusArrivalAtStop,
} from "../modules/transit/bus.service";
import { equalStopName } from "../utils/transit-text";
import { taipeiHHmm, taipeiWeekday } from "../config/taipei-time";

const PER_CITY = Number(process.env.PER_CITY ?? 4);
const OUT = process.env.OUT!;
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

let captured: { url: string; body: any }[] = [];
const orig = fetchMod.tdxFetch;
fetchMod.tdxFetch = async (url: string, ...rest: any[]) => {
  const res: any = await orig(url, ...rest);
  let body: any = null;
  try {
    body = JSON.parse(await res.clone().text());
  } catch {}
  captured.push({ url, body: res.ok ? body : { status: res.status } });
  return res;
};

const LABEL_OK = [
  /^正常$/,
  /^交管不停靠$/,
  /^暫無到站資訊$/,
  /^尚未發車$/,
  /^末班車已過$/,
  /^今日未營運$/,
  /^\d{2}:\d{2}( 起點發車)?$/,
  /^明日 \d{2}:\d{2}( 起點發車)?$/,
  /^週[日一二三四五六] \d{2}:\d{2}( 起點發車)?$/,
  /^\d{2}\/\d{2} \d{2}:\d{2}$/,
  /^每 \d+(–\d+)? 分一班$/,
  /^班距發車中$/,
];
const PLACEHOLDER = ["尚未發車", "末班車已過", "今日未營運", "暫無到站資訊"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function audit(
  d: any,
  s: any,
  etaRows: any[],
  schedRows: any[],
  nowHHmm: string,
  dow: number,
  v: string[],
) {
  const raw = etaRows.filter(
    (r) =>
      r.Direction === d.direction &&
      equalStopName(r.StopName?.Zh_tw, s.name) &&
      (!r.SubRouteUID || !d.subRouteUid || r.SubRouteUID === d.subRouteUid),
  );
  const rawEst = raw
    .map((r) => r.EstimateTime)
    .filter((x) => typeof x === "number" && x >= 0);
  const tag = `[dir${d.direction}/${d.subRouteUid ?? "-"}] ${s.seq ?? ""}.${s.name ?? s.stopName}`;
  const label: string = s.statusLabel;
  if (!LABEL_OK.some((re) => re.test(label)))
    v.push(`格式異常 ${tag}: "${label}"`);
  if (rawEst.length && s.estimateMinutes == null)
    v.push(`TDX有預估(${rawEst})但輸出null ${tag}`);
  if (
    rawEst.length &&
    s.estimateMinutes != null &&
    s.estimateMinutes !== Math.round(Math.min(...rawEst) / 60)
  )
    v.push(`預估分鐘不符 ${tag}: out=${s.estimateMinutes} raw=${rawEst}`);
  if (s.estimateMinutes != null && label === "尚未發車")
    v.push(`有預估仍標尚未發車 ${tag}`);
  if (PLACEHOLDER.includes(label)) {
    const dirSched = schedRows.filter((x) => x.Direction === d.direction);
    const hasSched = dirSched.some(
      (x) => (x.Frequencys ?? []).length || (x.Timetables ?? []).length,
    );
    v.push(
      `${hasSched ? "有班表卻" : "上游無班表→"}顯示${label} ${tag} rawN1=${raw.length} rawStatus=${raw.map((r) => r.StopStatus)}`,
    );
  }
  const m = label.match(/^(\d{2}:\d{2})/);
  if (m && s.estimateMinutes == null && m[1] < nowHHmm)
    v.push(`今日時間已過去 ${tag}: ${label} now=${nowHHmm}`);
  if (/^每 /.test(label)) {
    const active = schedRows.some(
      (x) =>
        x.Direction === d.direction &&
        (x.Frequencys ?? []).some(
          (f: any) =>
            f.ServiceDay?.[DAYS[dow]] &&
            f.StartTime <= nowHHmm &&
            f.EndTime > nowHHmm,
        ),
    );
    if (!active) v.push(`宣稱班距中但原始班表此刻無營運時段 ${tag}`);
  }
  const rawNext = raw.find((r) => r.NextBusTime)?.NextBusTime;
  if (
    rawNext &&
    s.estimateMinutes == null &&
    !label.includes(taipeiHHmm(new Date(rawNext)))
  )
    v.push(`NextBusTime未採用 ${tag}: raw=${rawNext} out=${label}`);
  return s.estimateMinutes != null
    ? "預估分鐘"
    : label.replace(/\d{2}:\d{2}/, "HH:mm").replace(/\d+(–\d+)?/, "N");
}

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!, {
    serverSelectionTimeoutMS: 5000,
  });
  const cities: string[] = (await BusRouteModel.distinct("city")).sort();
  const report: any[] = [];
  for (const city of cities) {
    const reuse = process.env.REUSE
      ? JSON.parse(fs.readFileSync(process.env.REUSE, "utf8"))
          .filter((e: any) => e.city === city)
          .map((e: any) => e.routeName)
      : null;
    const names: string[] =
      reuse ??
      (
        await BusRouteModel.aggregate([
          { $match: { city } },
          { $group: { _id: "$routeName.Zh_tw" } },
          { $sample: { size: PER_CITY } },
        ])
      ).map((r: any) => r._id);
    for (const [i, routeName] of names.entries()) {
      captured = [];
      const now = new Date();
      const nowHHmm = taipeiHHmm(now);
      const dow = taipeiWeekday(now);
      const t0 = Date.now();
      const res: any = await getBusRouteDetail({
        routeName,
        city: city as any,
      });
      const entry: any = {
        city,
        routeName,
        ms: Date.now() - t0,
        now: nowHHmm,
        tdx: captured.map(
          (c) =>
            `${c.url.replace(/^.*\/v2\/Bus\//, "").slice(0, 90)} → ${Array.isArray(c.body) ? c.body.length : JSON.stringify(c.body)}`,
        ),
      };
      if (!res.ok) {
        entry.error = `${res.status} ${res.error}`;
        report.push(entry);
        console.log(city, routeName, "ERROR", entry.error);
        await sleep(2500);
        continue;
      }
      const etaRows = captured
        .filter(
          (c) =>
            c.url.includes("EstimatedTimeOfArrival") && Array.isArray(c.body),
        )
        .flatMap((c) => c.body);
      const schedRows = captured
        .filter((c) => c.url.includes("Schedule") && Array.isArray(c.body))
        .flatMap((c) => c.body);
      const labels: Record<string, number> = {};
      const violations: string[] = [];
      let stops = 0;
      for (const d of res.directions)
        for (const s of d.stops) {
          stops++;
          const k = audit(d, s, etaRows, schedRows, nowHHmm, dow, violations);
          labels[k] = (labels[k] ?? 0) + 1;
        }
      Object.assign(entry, {
        stops,
        labels,
        etaRows: etaRows.length,
        schedRows: schedRows.length,
        violations,
      });

      if (i === 0) {
        await sleep(2000);
        const dir = res.directions[0];
        const stop = dir?.stops[Math.floor((dir.stops.length - 1) / 2)];
        if (stop) {
          captured = [];
          const a: any = await getBusArrivalAtStop({
            routeName,
            stopName: stop.name,
            city: city as any,
          });
          const aEta = captured
            .filter(
              (c) =>
                c.url.includes("EstimatedTimeOfArrival") &&
                Array.isArray(c.body),
            )
            .flatMap((c) => c.body);
          const aSched = captured
            .filter((c) => c.url.includes("Schedule") && Array.isArray(c.body))
            .flatMap((c) => c.body);
          entry.arrival = a.ok
            ? {
                stop: stop.name,
                arrivals: a.arrivals.map(
                  (x: any) =>
                    `${x.directionLabel}:${x.estimateMinutes ?? "-"}/${x.statusLabel}`,
                ),
              }
            : { stop: stop.name, error: `${a.status} ${a.error}` };
          if (a.ok)
            for (const x of a.arrivals)
              audit(
                { direction: x.direction, subRouteUid: x.subRouteUid },
                x,
                aEta,
                aSched,
                taipeiHHmm(),
                taipeiWeekday(),
                violations,
              );
        }
      }
      report.push(entry);
      console.log(
        city,
        routeName,
        `${entry.ms}ms stops=${stops}`,
        JSON.stringify(labels),
        entry.arrival
          ? `arrival=${JSON.stringify(entry.arrival.arrivals ?? entry.arrival.error)}`
          : "",
        violations.length ? `⚠️${violations.length}` : "OK",
      );
      await sleep(2500);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.log("FATAL", e);
  process.exit(1);
});
