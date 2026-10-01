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
  const sameRoute = (r: any) =>
    r.Direction === d.direction &&
    (!r.SubRouteUID || !d.subRouteUid || r.SubRouteUID === d.subRouteUid);
  const byUid = s.stopUid
    ? etaRows.filter((r) => sameRoute(r) && r.StopUID === s.stopUid)
    : [];
  const raw = byUid.length
    ? byUid
    : etaRows.filter(
        (r) =>
          sameRoute(r) &&
          equalStopName(r.StopName?.Zh_tw, s.name ?? s.stopName),
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

function expectedFromRaw(
  schedRows: any[],
  d: any,
  s: any,
  isFirst: boolean,
  now: Date,
): string | null {
  const exact = schedRows.filter(
    (x) => x.Direction === d.direction && x.SubRouteUID === d.subRouteUid,
  );
  const rows = exact.length
    ? exact
    : schedRows.filter((x) => x.Direction === d.direction && !x.SubRouteUID);
  if (!rows.length) return null;
  const nowHHmm = taipeiHHmm(now);
  const today = taipeiWeekday(now);
  const runs = (sd: any, dow: number) =>
    !sd ||
    Object.keys(sd).filter((k) => k !== "ServiceTag").length === 0 ||
    !!sd[DAYS[dow]];
  for (const r of rows)
    for (const f of r.Frequencys ?? []) {
      if (
        runs(f.ServiceDay, today) &&
        f.StartTime <= nowHHmm &&
        f.EndTime > nowHHmm
      )
        return "班距中";
    }
  for (let off = 0; off <= 7; off++) {
    const dow = (today + off) % 7;
    const deps: { t: string; at: boolean }[] = [];
    for (const r of rows) {
      for (const f of r.Frequencys ?? [])
        if (runs(f.ServiceDay, dow) && f.StartTime)
          deps.push({ t: f.StartTime, at: false });
      for (const t of r.Timetables ?? []) {
        if (!runs(t.ServiceDay, dow)) continue;
        const sts = (t.StopTimes ?? []).filter(
          (x: any) => x.ArrivalTime || x.DepartureTime,
        );
        if (!sts.length) continue;
        const here =
          sts.length > 1
            ? sts.find((x: any) => equalStopName(x.StopName?.Zh_tw, s.name))
            : undefined;
        const st = here ?? sts[0];
        deps.push({
          t: st.ArrivalTime || st.DepartureTime,
          at: !!here || equalStopName(sts[0].StopName?.Zh_tw, s.name),
        });
      }
    }
    const next = deps
      .filter((x) => off > 0 || x.t >= nowHHmm)
      .sort((a, b) => a.t.localeCompare(b.t))[0];
    if (!next) continue;
    const pre =
      off === 0 ? "" : off === 1 ? "明日 " : `週${"日一二三四五六"[dow]} `;
    return `${pre}${next.t}${next.at || isFirst ? "" : " 起點發車"}`;
  }
  return null;
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
      let schedChecked = 0;
      for (const d of res.directions)
        for (const s of d.stops) {
          stops++;
          const k = audit(d, s, etaRows, schedRows, nowHHmm, dow, violations);
          const fromSched =
            s.estimateMinutes == null &&
            /(\d{2}:\d{2})|分一班/.test(s.statusLabel) &&
            !etaRows.some(
              (r) =>
                r.NextBusTime &&
                r.Direction === d.direction &&
                (r.StopUID === s.stopUid ||
                  (!s.stopUid && equalStopName(r.StopName?.Zh_tw, s.name))) &&
                new Date(r.NextBusTime).getTime() >= now.getTime() - 60000,
            );
          if (fromSched) {
            schedChecked++;
            const exp = expectedFromRaw(
              schedRows,
              d,
              s,
              d.stops.indexOf(s) === 0,
              now,
            );
            const ok =
              exp === "班距中"
                ? /分一班|班距/.test(s.statusLabel)
                : exp === s.statusLabel;
            if (!ok)
              violations.push(
                `班表推算不符 [dir${d.direction}/${d.subRouteUid}] ${s.seq}.${s.name}: out="${s.statusLabel}" 獨立推算="${exp}"`,
              );
          }
          labels[k] = (labels[k] ?? 0) + 1;
        }
      Object.assign(entry, {
        stops,
        schedChecked,
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
