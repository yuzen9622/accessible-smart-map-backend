import { randomBytes } from "crypto";
import { redisGet, redisSetChecked } from "../../config/redis";
import { AiRoutePlanToolResultSchema } from "../ai/ai.schema";

import {
  LINE_PLAN_PREVIEW_TTL_SEC,
  LINE_PLAN_TOKEN_PATTERN,
} from "./line.constants";
const previewKey = (token: string) => `line:plan-preview:${token}`;

function parsePlan(value: unknown) {
  const parsed = AiRoutePlanToolResultSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.routes.some(
    (route) => route.routeId === parsed.data.selectedRouteId,
  )
    ? parsed.data
    : null;
}

export async function storeLinePlanPreview(
  value: unknown,
): Promise<string | null> {
  const plan = parsePlan(value);
  if (!plan) return null;
  const token = randomBytes(32).toString("base64url");
  return (await redisSetChecked(
    previewKey(token),
    JSON.stringify(plan),
    LINE_PLAN_PREVIEW_TTL_SEC,
  ))
    ? token
    : null;
}

export async function getLinePlanPreview(token: string) {
  if (!LINE_PLAN_TOKEN_PATTERN.test(token)) return null;
  const raw = await redisGet(previewKey(token));
  if (!raw) return null;
  try {
    return parsePlan(JSON.parse(raw));
  } catch {
    return null;
  }
}
