import { runtime } from "@/index.ts";
import { createIngestRouter } from "./ingest.handlers.ts";
import { ingestServiceSpace } from "./service-space.ts";

export default createIngestRouter({
  runtime: () => runtime,
  serviceSpace: ingestServiceSpace,
});
