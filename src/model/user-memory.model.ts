import { Schema, model } from "mongoose";

export interface IUserMemory {
  _id: string;
  userId: string;
  // Live-memory shape. Tombstones (deletedAt set) keep only ids and
  // timestamps, see MEMORY_TOMBSTONE_UNSET; live queries never return them.
  content: string;
  promptText: string;
  retrievalText: string;
  category: "preference" | "place" | "habit" | "context";
  sensitivity: "low" | "medium" | "high";
  source: "explicit_user" | "agent_suggested" | "distilled";
  embeddingId?: string;
  embeddingModel?: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userMemorySchema = new Schema<IUserMemory>(
  {
    userId: { type: String, required: true },
    // Not `required` at the DB layer: tombstones drop these. The memory
    // service always supplies them for live memories.
    content: { type: String },
    promptText: { type: String },
    retrievalText: { type: String },
    // Required for live memories; tombstones drop it (see
    // MEMORY_TOMBSTONE_UNSET), which update operators do not validate.
    category: {
      type: String,
      enum: ["preference", "place", "habit", "context"],
      required: true,
    },
    sensitivity: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
      default: "medium",
    },
    source: {
      type: String,
      enum: ["explicit_user", "agent_suggested", "distilled"],
      required: true,
      default: "explicit_user",
    },
    embeddingId: { type: String },
    embeddingModel: { type: String },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

userMemorySchema.index({ userId: 1, updatedAt: -1 });
userMemorySchema.index({ userId: 1, category: 1, deletedAt: 1 });
userMemorySchema.index({ userId: 1, embeddingId: 1 });
// Retention: due-memory scan (both `$or` branches), tombstone purge and
// per-owner reconciliation, and global vector-id lookups.
userMemorySchema.index({ deletedAt: 1, updatedAt: 1 });
userMemorySchema.index({ deletedAt: 1, expiresAt: 1 });
userMemorySchema.index({ deletedAt: 1, userId: 1 });
userMemorySchema.index({ embeddingId: 1 });

/**
 * Fields a tombstone drops. A tombstone keeps only `_id`, `userId`,
 * `embeddingId`, `deletedAt` and the timestamps, which is what vector
 * reconciliation needs.
 */
export const MEMORY_TOMBSTONE_UNSET = {
  content: "",
  promptText: "",
  retrievalText: "",
  category: "",
  sensitivity: "",
  source: "",
  embeddingModel: "",
  lastUsedAt: "",
  expiresAt: "",
} as const;

const UserMemory = model<IUserMemory>("UserMemory", userMemorySchema);
export default UserMemory;
