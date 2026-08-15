import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  mercatorToWgs84,
  parseFacilityDetailHtml,
  parseFacilityResultHtml,
  parseGeoPoint,
} from "./campus-a11y-parse";

const encode = (s: string) =>
  [...s]
    .map((c) => `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`)
    .join("");

const button = (opts: {
  facUid: string;
  type: string;
  facType: string;
  name: string;
  buildingUid: string;
  floorId: string;
}) => `
  <button class="fa-solid fa-elevator btn-fac-detail" type="button" data-bs-toggle="modal"
          data-bs-target="#FacilityModal"
          data-type="${opts.type}" data-fac-uid="${opts.facUid}"
          data-building-uid="${opts.buildingUid}" data-floor-id="${opts.floorId}"
          aria-label="${encode(`查看詳情：${opts.facType}，${opts.name} (開啟視窗)`)}"
          aria-haspopup="dialog">
      ${encode(opts.name)}
  </button>`;

const SAMPLE_HTML = `
<section class="result-area">
  <header>
    <h1 class="school-title"><label>${encode("國立測試大學")}</label></h1>
    <p class="school-info">
      <a class="btn-outline-primary btn-GoMap" href="#" data-geo="POINT (13529069.669036 2877830.51267)">校園路線</a>
      <span>校園地址： 106 ${encode("臺北市大安區測試路1號")}</span>
      <span>聯絡電話： 02-12345678</span>
      <span> ${encode("共")} 1 ${encode("筆建物，2 筆設施")} </span>
    </p>
  </header>
  <article class="result-all-item">
    <h2 id="title-b1" class="fa fa-shop" aria-label="${encode("綜合體育館")}">
      <span>${encode("綜合體育館")}</span>
    </h2>
    <div class="level" data-level="B1 ">
      ${button({ facUid: "fac-1", type: "8", facType: "無障礙電梯", name: "昇降設備", buildingUid: "b-1", floorId: "f-b1" })}
    </div>
    <div class="level" data-level="1F">
      ${button({ facUid: "fac-1", type: "8", facType: "無障礙電梯", name: "昇降設備", buildingUid: "b-1", floorId: "f-1f" })}
      ${button({ facUid: "fac-2", type: "2", facType: "無障礙坡道", name: "坡道及扶手", buildingUid: "b-1", floorId: "f-1f" })}
    </div>
  </article>
</section>`;

const NO_RESULT_HTML = `
<section class="result-area">
  <article id="noResult"><h2>${encode("查無資料")}</h2></article>
</section>`;

describe("decodeHtmlEntities", () => {
  it("decodes hex, decimal, and named entities", () => {
    expect(decodeHtmlEntities("&#x81FA;&#21271;&amp;&quot;")).toBe('臺北&"');
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
  });
});

describe("mercatorToWgs84 / parseGeoPoint", () => {
  it("converts EPSG:3857 to WGS84 (NTU main campus)", () => {
    const { lat, lng } = mercatorToWgs84(13529069.669036, 2877830.51267);
    expect(lat).toBeCloseTo(25.0169811, 5);
    expect(lng).toBeCloseTo(121.5337007, 5);
  });

  it("parses WKT points and rejects other strings", () => {
    expect(
      parseGeoPoint("POINT (13529069.669036 2877830.51267)"),
    ).not.toBeNull();
    expect(parseGeoPoint("not a point")).toBeNull();
  });
});

describe("parseFacilityResultHtml", () => {
  it("detects the no-result page", () => {
    const r = parseFacilityResultHtml(NO_RESULT_HTML);
    expect(r.noResult).toBe(true);
    expect(r.facilities).toHaveLength(0);
  });

  it("extracts campus header info", () => {
    const r = parseFacilityResultHtml(SAMPLE_HTML);
    expect(r.noResult).toBe(false);
    expect(r.campusGeo?.lat).toBeCloseTo(25.0169811, 5);
    expect(r.address).toBe("106 臺北市大安區測試路1號");
    expect(r.phone).toBe("02-12345678");
    expect(r.buildingCount).toBe(1);
    expect(r.facilityCount).toBe(2);
  });

  it("deduplicates multi-floor facilities by fac-uid and merges floors", () => {
    const r = parseFacilityResultHtml(SAMPLE_HTML);
    expect(r.facilities).toHaveLength(2);

    const elevator = r.facilities.find((f) => f.facUid === "fac-1");
    expect(elevator).toMatchObject({
      facTypeId: 8,
      facType: "無障礙電梯",
      name: "昇降設備",
      building: "綜合體育館",
      buildingUid: "b-1",
      floors: ["B1", "1F"],
      floorIds: ["f-b1", "f-1f"],
    });

    const ramp = r.facilities.find((f) => f.facUid === "fac-2");
    expect(ramp).toMatchObject({
      facTypeId: 2,
      facType: "無障礙坡道",
      floors: ["1F"],
    });
  });

  it("strips inlined base64 images before parsing", () => {
    const bloated = SAMPLE_HTML.replace(
      "校園路線",
      `<img src="data:image/jpg;base64,${"A".repeat(5000)}">校園路線`,
    );
    const r = parseFacilityResultHtml(bloated);
    expect(r.facilities).toHaveLength(2);
  });
});

const DETAIL_HTML = `
<div class="fac-detail"
     data-facility-geo="POINT (13434370.47 2771637.896)"
     data-building-geo="POLYGON ((13434364 2771689, 13434420 2771667))">
  <img src="data:image/JPG;base64,${"A".repeat(4000)}">
  <h2>中正大樓 B2 無障礙電梯</h2>
  <ul>
    <li>●機門寬度:90公分</li>
    <li>●機廂深度:150公分</li>
    <li>●樓層觸覺裝置:是</li>
    <li>●按鈕旁點字:是</li>
  </ul>
  <button>帶我前往</button><button>關閉</button>
</div>`;

describe("parseFacilityDetailHtml", () => {
  it("extracts the facility's own WGS84 coordinate", () => {
    const { geo } = parseFacilityDetailHtml(DETAIL_HTML);
    expect(geo).not.toBeNull();
    expect(geo!.lat).toBeCloseTo(24.149516, 4);
    expect(geo!.lng).toBeCloseTo(120.683003, 4);
  });

  it("parses spec bullets into label/value pairs without swallowing button text", () => {
    const { specs } = parseFacilityDetailHtml(DETAIL_HTML);
    expect(specs).toEqual([
      { label: "機門寬度", value: "90公分" },
      { label: "機廂深度", value: "150公分" },
      { label: "樓層觸覺裝置", value: "是" },
      { label: "按鈕旁點字", value: "是" },
    ]);
    // the last bullet's value stops at the tag boundary, not "是 帶我前往"
    expect(specs.at(-1)!.value).toBe("是");
  });

  it("returns null geo and empty specs when absent, after stripping base64", () => {
    const html = `<div><img src="data:image/png;base64,${"B".repeat(3000)}"><p>無資料</p></div>`;
    const r = parseFacilityDetailHtml(html);
    expect(r.geo).toBeNull();
    expect(r.specs).toEqual([]);
  });
});
