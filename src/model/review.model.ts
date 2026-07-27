import { Schema, model } from "mongoose";

export type PlaceType = "osm" | "a11y" | "bathroom" | "welfare" | "parking" | "google";
export type ReviewStatus = "active" | "deleted";

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
