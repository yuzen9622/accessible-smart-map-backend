import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import {
  ERROR_MESSAGE,
  TRAFFIC_MSG,
  TRAFFIC_REASON,
} from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type { ApiResponse } from "../../types/response";
import type { RoadIncident, TrafficFlowCollection } from "../../types/traffic";
import { getActiveRoadIncidents } from "./road-incident.service";
import {
  getTrafficFlowCollection,
  TrafficSectionUnavailableError,
} from "./traffic-flow.service";
import { parseBbox } from "./traffic.schema";

export async function getTrafficFlow(
  req: Request,
  res: Response<
    ApiResponse<TrafficFlowCollection | { reason: string; suggestion: string }>
  >,
) {
  try {
    const { bbox, minLevel, city } = req.query as {
      bbox?: string;
      minLevel?: string | number;
      city?: string;
    };

    const parsedBbox = bbox ? parseBbox(bbox) : undefined;
    const parsedMinLevel =
      minLevel !== undefined ? Number(minLevel) : undefined;

    const result = await getTrafficFlowCollection({
      bbox: parsedBbox,
      city,
      minLevel: parsedMinLevel,
    });

    const message = result.meta.liveUpdatedAt
      ? TRAFFIC_MSG.OK
      : TRAFFIC_MSG.FLOW_LIVE_DEGRADED;

    return sendResponse(res, true, "success", ResponseCode.OK, message, result);
  } catch (error) {
    if (error instanceof TrafficSectionUnavailableError) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INTERNAL_ERROR,
        TRAFFIC_MSG.SECTION_DB_ERROR,
        {
          reason: TRAFFIC_REASON.SECTION_DB_ERROR,
          suggestion:
            "請先執行 npx ts-node src/scripts/import-traffic-sections.ts",
        },
      );
    }

    console.error("[traffic] Error in getTrafficFlow:", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

export async function getRoadIncidents(
  req: Request,
  res: Response<ApiResponse<RoadIncident[]>>,
) {
  try {
    const { bbox, city } = req.query as {
      bbox?: string;
      city?: string;
    };

    const parsedBbox = bbox ? parseBbox(bbox) : undefined;
    const incidents = await getActiveRoadIncidents({
      bbox: parsedBbox,
      city,
    });

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      TRAFFIC_MSG.INCIDENT_OK,
      incidents,
    );
  } catch (error) {
    console.error("[traffic] Error in getRoadIncidents:", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}
