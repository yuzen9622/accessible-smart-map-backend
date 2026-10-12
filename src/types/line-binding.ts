export type LineBindingFailure = {
  ok: false;
  error: string;
  errorCode?:
    "NO_EMERGENCY_BIND_CODE" | "NO_LINE_BIND_CODE" | "BIND_OUTCOME_UNCONFIRMED";
};

export type EmergencyContactBindingResult =
  | LineBindingFailure
  | { ok: true; bound: true; contactId: string; contactName: string };

export type LineAccountBindingResult =
  | LineBindingFailure
  | {
      ok: true;
      bound: true;
      userId: string;
      userName: string;
      bindUrl: string;
    };
