export enum ResponseCode {
  OK = 200,
  CREATED = 201,
  UPDATED = 204,
  INVALID_INPUT = 400,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  UNAUTHORIZED = 401,
  CONFLICT = 409,
  GONE = 410,
  TOO_MANY_REQUESTS = 429,
  INTERNAL_ERROR = 500,
  SERVICE_UNAVAILABLE = 503,
}

export const ResponseMessage: Record<keyof typeof ResponseCode, string> = {
  OK: "OK",
  CREATED: "Created",
  UPDATED: "Updated",
  INVALID_INPUT: "Invalid input",
  FORBIDDEN: "Forbidden",
  NOT_FOUND: "Not found",
  UNAUTHORIZED: "Unauthorized",
  CONFLICT: "Conflict",
  GONE: "Gone",
  TOO_MANY_REQUESTS: "Too many requests",
  INTERNAL_ERROR: "Internal server error",
  SERVICE_UNAVAILABLE: "Service unavailable",
};
