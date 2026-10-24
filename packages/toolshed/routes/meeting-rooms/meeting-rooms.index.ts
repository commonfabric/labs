/** Routes bound to this host's durable meeting allocation store. */

import { fromFileUrl } from "@std/path";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import { MeetingRooms } from "@/lib/meeting-rooms.ts";
import { memoryEngineStoreUrl, memoryServer } from "@/routes/storage/memory.ts";
import { createMeetingRoomRouter } from "./router.ts";

export default createMeetingRoomRouter({
  rooms: new MeetingRooms({
    path: fromFileUrl(new URL("meeting-rooms.sqlite", memoryEngineStoreUrl)),
    server: memoryServer,
    createSpace: async (creator, root) => {
      const storage = StorageManager.open({
        memoryHost: new URL(env.MEMORY_URL),
        as: identity,
      });
      try {
        return await storage.createSpace({ [creator]: "OWNER" }, {
          root,
          spaceKind: "loom",
        });
      } finally {
        await storage.close();
      }
    },
  }),
  host: env.API_URL,
  available: env.MEMORY_ROUTER_CONFIG_FILE === "",
});
