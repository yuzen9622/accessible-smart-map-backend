import type { Request, Response } from "express";
import { ResponseCode } from "../../types/code";
import { sendResponse } from "../../config/lib";
import * as service from "./line.service";
import type { LineEvent } from "./line.types";
import type { z } from "zod";
import type { RoutePreviewQuerySchema } from "./line.schema";

/**
 * Webhook handler: acknowledges with 200 immediately (LINE resends on slow
 * ACK), then processes events asynchronously.
 *
 * @param req Express request (body already signature-verified and parsed).
 * @param res Express response.
 */
export function handleWebhook(req: Request, res: Response) {
  res.status(ResponseCode.OK).json({ ok: true });

  const events = ((req.body?.events as LineEvent[]) ?? []) as LineEvent[];
  void service.handleEvents(events).catch((err) => {
    console.error("[line.controller] handleEvents failed", err);
  });
}

export async function getRoutePreview(req: Request, res: Response) {
  const query = req.validated?.query as z.infer<typeof RoutePreviewQuerySchema>;
  const result = await service.getRoutePreview(
    query.sessionId ?? query.planToken ?? "",
    query.travelMode,
    query.mode,
    query.departureTime,
  );
  res.setHeader("Cache-Control", "no-store");
  return sendResponse(
    res,
    result.ok,
    result.ok ? "success" : "error",
    result.httpCode,
    result.message,
    result.data,
  );
}
