import { planAccessibleRouteFromRequest } from "../modules/accessible-route/accessible-route.service";

async function runLiveRoutePlanningTest() {
  console.log("=================================================");
  console.log(
    " 🚀 台北市公車與大眾運輸【路徑規劃服務】實測 (Live Route Planning)",
  );
  console.log("=================================================\n");

  // 1. 政大 ➔ 台北車站 (輪椅使用者無障礙公車路徑規劃)
  console.log("📍 [測試情境 1] 出發地：國立政治大學 ➔ 目的地：台北車站");
  console.log(
    "   無障礙模式：輪椅 (wheelchair) | 運具：transit (大眾運輸/公車)\n",
  );

  const req1 = {
    travelMode: "transit" as const,
    origin: { latitude: 24.9868, longitude: 121.5762 }, // 政大
    destination: { latitude: 25.0478, longitude: 121.517 }, // 台北車站
    mode: "wheelchair" as const,
  };

  try {
    const res1 = await planAccessibleRouteFromRequest(req1);
    console.log("HTTP / Service 響應狀態: ok =", res1.ok);
    if (res1.ok) {
      console.log(`城市解算: ${res1.data.city}`);
      console.log(`共規劃出 ${res1.data.routes.length} 條候選路徑：\n`);
      res1.data.routes.forEach((r, i) => {
        console.log(`  #${i + 1} 【${r.routeName}】`);
        console.log(
          `     預估總時間: ${r.totalMinutes} 分鐘 | 轉乘次數: ${r.transferCount} 次 | 總步行: ${r.totalWalkDistanceM} 公尺`,
        );
        console.log(
          `     無障礙分數: ${r.accessibilityScore} 分 (${r.accessibilityLabel ?? "未定"}) | 數據信心度: ${r.dataConfidence}`,
        );
        if (r.accessibilityHighlights.length) {
          console.log(
            `     無障礙亮點: ${r.accessibilityHighlights.join("、")}`,
          );
        }
        console.log(`     Legs 結構 (${r.legs.length} 段):`);
        r.legs.forEach((leg, j) => {
          if (leg.type === "BUS") {
            console.log(
              `       - [Leg ${j + 1}] 公車 (BUS): ${leg.routeName} | ${leg.departureStop} ➔ ${leg.arrivalStop} (即時等候: ${leg.estimatedWaitMinutes}分)`,
            );
          } else if (leg.type === "WALK") {
            console.log(
              `       - [Leg ${j + 1}] 步行 (WALK): ${leg.from || "點"} ➔ ${leg.to || "點"} (約 ${leg.distanceM}m)`,
            );
          } else if (leg.type === "METRO") {
            console.log(
              `       - [Leg ${j + 1}] 捷運 (METRO): ${leg.lineName} | ${leg.departureStation} ➔ ${leg.arrivalStation}`,
            );
          }
        });
        console.log("");
      });
    } else {
      console.log("錯誤回應:", res1.error);
    }
  } catch (err: any) {
    console.error("執行失敗:", err.message);
  }

  // 2. 板橋車站 ➔ 撫遠街口 (307 幹線公車規劃)
  console.log("-------------------------------------------------");
  console.log("📍 [測試情境 2] 出發地：板橋車站 ➔ 目的地：撫遠街口");
  console.log("   無障礙模式：高齡者 (elderly) | 運具：transit\n");

  const req2 = {
    travelMode: "transit" as const,
    origin: { latitude: 25.0143, longitude: 121.4638 }, // 板橋車站
    destination: { latitude: 25.0602, longitude: 121.5684 }, // 撫遠街口
    mode: "elderly" as const,
  };

  try {
    const res2 = await planAccessibleRouteFromRequest(req2);
    console.log("HTTP / Service 響應狀態: ok =", res2.ok);
    if (res2.ok) {
      console.log(`共規劃出 ${res2.data.routes.length} 條候選路徑：`);
      res2.data.routes.slice(0, 2).forEach((r, i) => {
        console.log(
          `  #${i + 1} 【${r.routeName}】 時間: ${r.totalMinutes}分 | 步行: ${r.totalWalkDistanceM}m | 分數: ${r.accessibilityScore}`,
        );
      });
    } else {
      console.log("錯誤回應:", res2.error);
    }
  } catch (err: any) {
    console.error("執行失敗:", err.message);
  }
}

runLiveRoutePlanningTest().catch(console.error);
