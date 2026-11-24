import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

export const tags = ["Memory Storage"];

export const subscribe = createRoute({
  method: "get",
  path: "/api/storage/memory",
  tags,
  request: {
    headers: z.object({
      // Connection header is a list of values that must include Upgrade
      connection: z.string().regex(/(^|\s*,\s*)Upgrade(\s*,\s*|$)/i),
      // Upgrade header is a list of values that must include websocket (and possible version)
      upgrade: z.string().regex(/(^|\s*,\s*)websocket(\/[^,]+)?(\s*,\s*|$)/i),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      headers: z.object({
        connection: z.literal("Upgrade"),
        upgrade: z.literal("websocket"),
        "sec-websocket-accept": z.string(),
        date: z.string(),
      }),
      description: "WebSocket upgrade",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      description: "Upgrade to websocket failed",
    },
  },
});
