import type {
  LabelMetadataObservationClass,
  LabelObservationClass,
} from "./types.ts";
import {
  entryObservationClass,
  LABEL_METADATA_OBSERVATION,
  type ReadClassSelection,
  readConsumesEntry,
  type ReadObservationShape,
  readObservationShapes,
} from "@commonfabric/memory/v2/cfc-observation-classes";

// The observation classes are decided in the store, which reads labels by
// them too; the runner's callers reach them here. The persisted classes are
// the store's own unions, which `LabelObservationClass` and
// `LabelMetadataObservationClass` spell the same.
export {
  entryObservationClass,
  LABEL_METADATA_OBSERVATION,
  type ReadClassSelection,
  readConsumesEntry,
  type ReadObservationShape,
  readObservationShapes,
};

export type { LabelMetadataObservationClass, LabelObservationClass };
