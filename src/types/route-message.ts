import type { SupportedLang } from "./lang";

export type RouteMessageParams = Record<string, string | number | boolean>;

/** Backend-authored route copy, captured at the producer rather than inferred from prose. */
export interface RouteMessageDescriptor {
  code: string;
  params?: RouteMessageParams;
  /** Legacy Chinese text kept for old clients and old tokens. */
  legacyMessage: string;
}

export interface RouteMessageDetail {
  index: number;
  code: string;
  params?: RouteMessageParams;
  message: string;
}

export type RouteMessageLanguage = SupportedLang;
