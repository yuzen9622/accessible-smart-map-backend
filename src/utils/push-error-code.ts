import { EXPO_RECEIPT_ERROR_CODES } from "../constants/push";

/** Provider-controlled strings are never stored or logged: unknown codes collapse. */
export function normalizeReceiptErrorCode(code: unknown): string {
  return (EXPO_RECEIPT_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as string)
    : "UnknownError";
}
