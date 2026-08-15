import type { ResponseCode } from "./code";
export interface ApiResponse<T> {
  ok: boolean;
  status: "success" | "error";
  code: ResponseCode;
  message: string;
  data?: T;
  accessToken?: string;
}
