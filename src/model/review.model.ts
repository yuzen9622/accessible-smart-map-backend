import { Schema, model } from "mongoose";

export type PlaceType = "osm" | "a11y" | "bathroom" | "welfare" | "parking" | "google";
export type ReviewStatus = "active" | "deleted";
export type EntranceAccessibility =
  | "step_free"
  | "ramp"
  | "stairs_with_assistance"
  | "inaccessible";

export interface IReview {
  _id: string;
  placeId: string;
  placeType: PlaceType;
  userId: string;
  rating: number;
  passageWidthRating: number;
  toiletRating: number;
  elevatorRating: number;
  serviceRating: number;
  entranceAccessibility?: EntranceAccessibility;
  toiletTurningRoom?: boolean;
  wheelchairTableHeight?: boolean;
  adequateAisleWidth?: boolean;
  staffHelpfulnessRating?: number;
  aggregateAccessibilityScore?: number;
  comment?: string;
  status: ReviewStatus;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    placeId: { type: String, required: true },
    placeType: {
      type: String,
      enum: ["osm", "a11y", "bathroom", "welfare", "parking", "google"],
      required: true,
    },
    userId: { type: String, required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    passageWidthRating: { type: Number, min: 1, max: 5, required: true },
    toiletRating: { type: Number, min: 1, max: 5, required: true },
    elevatorRating: { type: Number, min: 1, max: 5, required: true },
    serviceRating: { type: Number, min: 1, max: 5, required: true },
    entranceAccessibility: {
      type: String,
      enum: ["step_free", "ramp", "stairs_with_assistance", "inaccessible"],
    },
    toiletTurningRoom: { type: Boolean },
    wheelchairTableHeight: { type: Boolean },
    adequateAisleWidth: { type: Boolean },
    staffHelpfulnessRating: {
      type: Number,
      min: 1,
      max: 5,
      validate: Number.isInteger,
    },
    aggregateAccessibilityScore: { type: Number, min: 1, max: 5 },
    comment: { type: String, maxlength: 500 },
    status: {
      type: String,
      enum: ["active", "deleted"],
      default: "active",
    },
  },
  { timestamps: true },
);

reviewSchema.index({ placeId: 1, placeType: 1, userId: 1 }, { unique: true });
reviewSchema.index({ placeId: 1, placeType: 1, status: 1 });
reviewSchema.index({ userId: 1, createdAt: -1 });

const Review = model<IReview>("Review", reviewSchema);

export default Review;
