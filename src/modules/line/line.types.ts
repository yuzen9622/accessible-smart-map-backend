import type { webhook } from "@line/bot-sdk";
import type { PlanRouteResult } from "../accessible-route/accessible-route.service";
import type { ResponseCode } from "../../types/code";
import type { SosType } from "../sos/sos.types";

export type LineEvent = webhook.Event;

export interface LineWebhookBody {
  destination?: string;
  events: LineEvent[];
}

export type PlanRouteData = Exclude<PlanRouteResult, { ok: false }>["data"];

export interface LineRoutePreviewData extends PlanRouteData {
  sessionId: string;
  ownerName: string;
  originLabel: string;
  destinationLabel: string;
}

export interface LineBoundContact {
  contactId: string;
  contactName: string;
  ownerId: string;
  ownerName: string;
  updatedAt?: Date;
}

export interface LineSosHistoryEntry {
  sessionId: string;
  ownerId: string;
  ownerName: string;
  type: SosType;
  status: "active" | "resolved";
  handlingStatus: string;
  address?: string | null;
  createdAt?: Date;
  resolvedAt?: Date | null;
  claimedByName?: string | null;
}

export interface LineSosHistoryData {
  entries: LineSosHistoryEntry[];
  owners: Array<{ ownerId: string; ownerName: string }>;
  activeOwnerId?: string;
}

export interface LineServiceResult<T = unknown> {
  ok: boolean;
  httpCode: ResponseCode;
  message: string;
  data?: T;
}
