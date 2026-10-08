import { Schema, model } from "mongoose";

/**
 * A deleted (or being-deleted) account, kept only long enough for the
 * retention sweep to remove data that concurrent requests wrote after the
 * deletion. Holds the user id and nothing else about the person.
 */
export interface IDeletedAccount {
  userId: string;
  /** `pending` until the user document itself is gone. */
  state: "pending" | "user_deleted";
  userDeletedAt?: Date;
  /** Last time a sweep still found and removed something. */
  lastFoundAt?: Date;
  lastSweptAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const deletedAccountSchema = new Schema<IDeletedAccount>(
  {
    userId: { type: String, required: true, unique: true },
    state: {
      type: String,
      enum: ["pending", "user_deleted"],
      required: true,
    },
    userDeletedAt: { type: Date },
    lastFoundAt: { type: Date },
    lastSweptAt: { type: Date },
  },
  { timestamps: true },
);

deletedAccountSchema.index({ lastSweptAt: 1 });

const DeletedAccount = model<IDeletedAccount>(
  "DeletedAccount",
  deletedAccountSchema,
);

export default DeletedAccount;
