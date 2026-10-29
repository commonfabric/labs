import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { MetaResponseSchema } from "./meta.handlers.ts";

const tags = ["Meta"];

export const index = createRoute({
  path: "/api/meta",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      MetaResponseSchema,
      "Meta information about the server",
    ),
  },
});

export type IndexRoute = typeof index;
