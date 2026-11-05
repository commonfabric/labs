/** Routes bound to this toolshed's authoritative memory server. */
import env from "@/env.ts";
import { memoryServer } from "@/routes/storage/memory.ts";
import { createSpaceInviteRouter } from "./router.ts";

export default createSpaceInviteRouter({
  server: memoryServer,
  host: env.API_URL,
});
