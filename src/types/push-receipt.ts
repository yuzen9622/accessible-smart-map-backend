export type PushReceiptState =
  | "awaiting_ticket"
  | "pending"
  | "cleanup_pending"
  | "provider_accepted"
  | "failed"
  | "unknown";

/** Private Expo ticket tracking record; never contains tokens or message content. */
export interface IPushReceipt {
  _id: string;
  attemptId: string;
  userId: string;
  tokenId: string;
  registrationVersion: string;
  authSessionId: string;
  state: PushReceiptState;
  ticketId?: string | null;
  attempts: number;
  nextAttemptAt: Date;
  deadlineAt: Date;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  errorCode?: string | null;
  createdAt: Date;
  expiresAt: Date;
}
