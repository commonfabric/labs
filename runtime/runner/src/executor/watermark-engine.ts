import {
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  type WatermarkDocValue,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

/**
 * Read W directly from the engine (the serving loop's activation read —
 * serving-loop.md §3: "W = read watermark doc (0 if absent)"). Direct
 * engine read on the co-hosted plane; clients read the same doc through
 * their ordinary subscription instead.
 */
export const readWatermarkSeq = (engine: Engine.Engine): number => {
  const state = Engine.readState(engine, {
    id: SERVER_EXECUTION_WATERMARK_DOC_ID as Parameters<
      typeof Engine.readState
    >[1]["id"],
  });
  const value = state?.document?.value as WatermarkDocValue | undefined;
  return typeof value?.seq === "number" ? value.seq : 0;
};
