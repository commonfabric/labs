import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import { jsonContent } from "stoker/openapi/helpers";
import * as HttpStatusCodes from "stoker/http-status-codes";

const tags = ["Auth"];

const UserProfileSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  shortName: z.string(),
  avatar: z.string().nullable(),
});

export const whoami = createRoute({
  method: "get",
  path: "/api/whoami",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      UserProfileSchema,
      "Current user profile",
    ),
  },
});
