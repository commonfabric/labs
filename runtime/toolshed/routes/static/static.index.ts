import { StaticCache } from "@commonfabric/static";
import { compareETags, createCacheHeaders } from "@commonfabric/static/etag";
import { cors } from "@hono/hono/cors";

import { createRouter } from "@/lib/create-app.ts";
import { getMimeType } from "@/lib/mime-type.ts";

const router = createRouter();

// Static cache instance - separate from runtime cache
// for isolation and performance
const cache = StaticCache.fromFileSystem();

router.use(
  "*",
  // These assets are the same for every caller and carry nothing about the
  // user, so the route serves them to any origin.
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  }),
);

router.get("/static/*", async (c) => {
  const reqPath = c.req.path.substring("/static/".length);
  const ifNoneMatch = c.req.header("If-None-Match");

  // Get the asset with its ETag
  const { blob, etag } = await cache.getWithETag(reqPath);

  // Check if client has matching ETag
  if (ifNoneMatch && compareETags(etag, ifNoneMatch)) {
    return new Response(null, {
      status: 304,
      headers: {
        "ETag": etag,
      },
    });
  }

  const mimeType = getMimeType(reqPath);

  // Simple caching: always validate with ETag
  const cacheHeaders = createCacheHeaders(etag);

  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      // Without this a `Blob` body goes out chunked, which leaves the client
      // with no length to show progress against.
      "Content-Length": String(blob.size),
      ...cacheHeaders,
    },
  });
});

export default router;
