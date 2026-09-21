/** Inbox endpoints owned by the serving memory instance. */

import env from "../../env.ts";
import { memoryServer } from "../storage/memory.ts";
import { createInboxRouter } from "./router.ts";
export default createInboxRouter({
  store: () => memoryServer.inboxStore(),
  host: env.API_URL,
});
