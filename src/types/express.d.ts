import type { IUser } from "./index";

declare global {
  namespace Express {
    interface Request {
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
      auth?: { userId: string; user: IUser };
    }
  }
}

export {};
