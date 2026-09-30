import type { Context } from "@hono/hono";
import { createPatternsRoute } from "./patterns-server.ts";

// Create a single route instance to be reused across requests: it memoizes
// each pattern's closure identity, which is fixed for the process's lifetime.
const patternsRoute = createPatternsRoute();

/**
 * Handler for serving pattern files from the patterns directory. The router
 * has already split the path, so the file is asked for by name; everything
 * else about the answer — validation, `?identity`, ETags, status mapping —
 * belongs to the route.
 */
export const getPattern = (c: Context): Promise<Response> => {
  const { filename } = c.req.param();
  const query = new URL(c.req.url).searchParams;
  return patternsRoute.serveFile(filename, {
    identity: query.has("identity"),
    sourceRoots: query.getAll("sourceRoot"),
    ifNoneMatch: c.req.header("If-None-Match"),
  });
};
