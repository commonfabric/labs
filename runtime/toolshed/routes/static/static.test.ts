import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { TEST_ASSET, TEST_ASSET_CONTENT } from "@commonfabric/static/utils";

import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import { getMimeType } from "@/lib/mime-type.ts";
import router from "@/routes/static/static.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

// The route serves whatever asset it is named, so which one these tests name
// does not matter.
const TEST_ASSET_PATH = `/static/${TEST_ASSET}`;

describe("Static Routes", () => {
  it("serves static files with correct content", async () => {
    const response = await app.request(TEST_ASSET_PATH);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.includes(TEST_ASSET_CONTENT)).toBe(true);
  });
});

describe("ETag HTTP Responses", () => {
  it("returns 200 with ETag header", async () => {
    const response = await app.request(TEST_ASSET_PATH);
    expect(response.status).toBe(200);

    const etag = response.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect(etag!.startsWith('"') && etag!.endsWith('"')).toBe(true);
  });

  it("returns 304 with matching If-None-Match", async () => {
    // First request to get the ETag
    const response1 = await app.request(TEST_ASSET_PATH);
    const etag = response1.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Second request with If-None-Match
    const response2 = await app.request(TEST_ASSET_PATH, {
      headers: {
        "If-None-Match": etag!,
      },
    });
    expect(response2.status).toBe(304);
  });

  it("returns 200 with non-matching If-None-Match", async () => {
    const response = await app.request(TEST_ASSET_PATH, {
      headers: {
        "If-None-Match": '"non-matching-etag"',
      },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("includes Cache-Control: public, no-cache header", async () => {
    const response = await app.request(TEST_ASSET_PATH);
    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toBe("public, no-cache");
  });

  it("serves files with the MIME type their extension maps to", async () => {
    const response = await app.request(TEST_ASSET_PATH);
    expect(response.headers.get("Content-Type")).toBe(getMimeType(TEST_ASSET));
  });

  it("sets `Content-Length` to the size of the body", async () => {
    const response = await app.request(TEST_ASSET_PATH);
    const body = await response.arrayBuffer();
    expect(response.headers.get("Content-Length")).toBe(
      String(body.byteLength),
    );
  });
});

describe("Caching Behavior", () => {
  it("returns same ETag for multiple requests", async () => {
    const response1 = await app.request(TEST_ASSET_PATH);
    const etag1 = response1.headers.get("ETag");

    const response2 = await app.request(TEST_ASSET_PATH);
    const etag2 = response2.headers.get("ETag");

    expect(etag1).toBe(etag2);
  });

  it("returns empty body for 304 response", async () => {
    // First request to get the ETag
    const response1 = await app.request(TEST_ASSET_PATH);
    const etag = response1.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Second request with If-None-Match
    const response2 = await app.request(TEST_ASSET_PATH, {
      headers: {
        "If-None-Match": etag!,
      },
    });

    expect(response2.status).toBe(304);
    const body = await response2.text();
    expect(body).toBe("");
  });

  it("includes ETag header in 304 response", async () => {
    // First request to get the ETag
    const response1 = await app.request(TEST_ASSET_PATH);
    const etag = response1.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Second request with If-None-Match
    const response2 = await app.request(TEST_ASSET_PATH, {
      headers: {
        "If-None-Match": etag!,
      },
    });

    expect(response2.status).toBe(304);
    const responseETag = response2.headers.get("ETag");
    expect(responseETag).toBe(etag);
  });

  it("returns 304 for wildcard If-None-Match", async () => {
    const response = await app.request(TEST_ASSET_PATH, {
      headers: {
        "If-None-Match": "*",
      },
    });
    expect(response.status).toBe(304);
  });

  it("returns 304 for comma-separated If-None-Match with matching ETag", async () => {
    // First request to get the ETag
    const response1 = await app.request(TEST_ASSET_PATH);
    const etag = response1.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Second request with comma-separated list including the matching ETag
    const response2 = await app.request(TEST_ASSET_PATH, {
      headers: {
        "If-None-Match": `"fake-etag-1", ${etag}, "fake-etag-2"`,
      },
    });
    expect(response2.status).toBe(304);
  });

  it("returns 304 for weak ETag match", async () => {
    // First request to get the ETag
    const response1 = await app.request(TEST_ASSET_PATH);
    const etag = response1.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Second request with weak ETag (W/ prefix)
    const response2 = await app.request(TEST_ASSET_PATH, {
      headers: {
        "If-None-Match": `W/${etag}`,
      },
    });
    expect(response2.status).toBe(304);
  });
});
