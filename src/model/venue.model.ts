import { model, Schema } from "mongoose";
import type { VenueDocument } from "../modules/venue/venue.types";

/**
 * One compiled venue per document (see src/modules/venue/venue.compile.ts).
 * The nested arrays are written whole by `import-venue-osm` and only read
 * back, so they are stored as Mixed rather than re-validated field by field.
 * `version` increases on every import; the venue graph cache keys on it.
 */
const venueSchema = new Schema<VenueDocument>(
  {
    venueId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    version: { type: Number, required: true },
    center: { type: [Number], required: true },
    buildings: { type: Schema.Types.Mixed, required: true },
    places: { type: Schema.Types.Mixed, required: true },
    nodes: { type: Schema.Types.Mixed, required: true },
    edges: { type: Schema.Types.Mixed, required: true },
    features: { type: Schema.Types.Mixed, required: true },
    warnings: { type: [String], default: [] },
    source: {
      file: { type: String, required: true },
      sha256: { type: String, required: true },
    },
    importedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

const VenueModel = model<VenueDocument>("Venue", venueSchema);

export default VenueModel;
