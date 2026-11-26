import { runtime } from "@/index.ts";
import { createWebhooksRouter } from "./webhooks.handlers.ts";

export default createWebhooksRouter({ runtime: () => runtime });
