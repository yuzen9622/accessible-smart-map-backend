import crypto from "crypto";
import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { HAZARD_MSG, HAZARD_REASON } from "../../constants/messages";
import { authenticateToken } from "../../config/auth";
import * as service from "./hazard-report.service";
import type {
  ConfirmAction,
  PhotoMimeType,
  ServiceResult,
} from "./hazard-report.types";
import type { HazardSeverity, HazardType } from "../../types";

const ALLOWED_STATUS = ["pending", "verified", "rejected", "expired"];

function send(res: Response, result: ServiceResult) {
  return sendResponse(
    res,
    result.ok,
    result.ok ? "success" : "error",
    result.httpCode as ResponseCode,
    result.message,
    result.data,
  );
}

function parseStatusList(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ALLOWED_STATUS.includes(s));
  return list.length ? list : undefined;
}

async function resolveIdentity(req: Request): Promise<string> {
  const token = req.headers.authorization?.split(" ")[1];
  if (token) {
    const result = await authenticateToken(token);
    if (result.ok) return result.userId;
  }
  const ip = req.ip ?? "unknown";
  return (
    "ip:" + crypto.createHash("sha256").update(ip).digest("hex").slice(0, 32)
  );
}

async function createReport(req: Request, res: Response) {
  if (!req.file) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      HAZARD_MSG.PHOTO_REQUIRED,
      { reason: HAZARD_REASON.PHOTO_REQUIRED },
    );
  }

  const body = req.validated?.body as {
    hazardType: HazardType;
    severity: HazardSeverity;
    latitude: number;
    longitude: number;
    description?: string;
    expectedUntil?: string;
  };

  const result = await service.createReport({
    reporterId: await resolveIdentity(req),
    hazardType: body.hazardType,
    severity: body.severity,
    latitude: body.latitude,
    longitude: body.longitude,
    description: body.description,
    expectedUntil: body.expectedUntil,
    photo: {
      buffer: req.file.buffer,
      mimeType: req.file.mimetype as PhotoMimeType,
    },
  });
  return send(res, result);
}

async function getNearbyReports(req: Request, res: Response) {
  const query = req.validated?.query as {
    lat: number;
    lng: number;
    radius?: number;
    hazardType?: HazardType;
    status?: string;
    limit?: number;
  };

  const result = await service.findNearby({
    lat: query.lat,
    lng: query.lng,
    radius: query.radius,
    hazardType: query.hazardType,
    status: parseStatusList(query.status),
    limit: query.limit,
  });
  return send(res, result);
}

async function getReport(req: Request, res: Response) {
  const result = await service.findById(req.params.id as string);
  return send(res, result);
}

async function getMyReports(req: Request, res: Response) {
  const query = req.validated?.query as {
    status?: string;
    hazardType?: HazardType;
    limit?: number;
    cursor?: string;
  };

  const result = await service.findMine({
    reporterId: req.auth!.userId,
    status: parseStatusList(query.status),
    hazardType: query.hazardType,
    limit: query.limit,
    cursor: query.cursor,
  });
  return send(res, result);
}

async function confirmReport(req: Request, res: Response) {
  const body = req.validated?.body as { action: ConfirmAction };
  const result = await service.confirmReport({
    reportId: req.params.id as string,
    action: body.action,
    voterId: await resolveIdentity(req),
  });
  return send(res, result);
}

export {
  createReport,
  getNearbyReports,
  getReport,
  getMyReports,
  confirmReport,
};
