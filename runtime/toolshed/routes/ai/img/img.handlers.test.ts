import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { QueueStatus } from "@fal-ai/client";

import type { ImageClient } from "./img.handlers.ts";
import { createImageRouter } from "./img.index.ts";
import { createTestApp } from "@/lib/create-app.ts";

const IMAGE_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
const IMAGE_URL = "https://fal.example/generated.webp";

type SubscribeOptions = Parameters<ImageClient["subscribe"]>[1];

const queueUpdates: QueueStatus[] = [
  {
    status: "IN_QUEUE",
    queue_position: 1,
    request_id: "r",
    response_url: "",
    status_url: "",
    cancel_url: "",
  },
  {
    status: "IN_PROGRESS",
    logs: [{ message: "step 1", level: "INFO", source: "USER", timestamp: "" }],
    request_id: "r",
    response_url: "",
    status_url: "",
    cancel_url: "",
  },
];

describe("img.handlers", () => {
  let tempDir: string;
  let cacheDir: string;
  let subscribeCalls: SubscribeOptions[];
  let fetchedUrls: string[];
  let generate: () => Promise<{ data?: { images?: { url?: string }[] } }>;
  let download: () => Promise<Response>;

  function app() {
    return createTestApp(createImageRouter({
      client: {
        subscribe(_endpointId, options) {
          subscribeCalls.push(options);
          queueUpdates.forEach(options.onQueueUpdate);
          return generate();
        },
      },
      fetch: (input) => {
        fetchedUrls.push(String(input));
        return download();
      },
      cacheDir,
    }));
  }

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    cacheDir = `${tempDir}/ai-img`;
    subscribeCalls = [];
    fetchedUrls = [];
    generate = () =>
      Promise.resolve({ data: { images: [{ url: IMAGE_URL }] } });
    download = () => Promise.resolve(new Response(IMAGE_BYTES));
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  describe("GET /api/ai/img", () => {
    it("generates a square image, downloads it, and serves it as a cache miss", async () => {
      const response = await app().request("/api/ai/img?prompt=cat");

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/webp");
      expect(response.headers.get("X-Disk-Cache")).toBe("MISS");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        IMAGE_BYTES,
      );
      expect(subscribeCalls.map((call) => call.input)).toEqual([
        { prompt: "cat", image_size: "square", num_images: 1 },
      ]);
      expect(fetchedUrls).toEqual([IMAGE_URL]);
    });

    it("returns the CORS origin header on the image response", async () => {
      const response = await app().request("/api/ai/img?prompt=cat", {
        headers: { Origin: "https://app.example.com" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Expose-Headers")).toContain(
        "X-Disk-Cache",
      );
    });

    it("requests a custom size when both width and height are given", async () => {
      const response = await app().request(
        "/api/ai/img?prompt=cat&width=640&height=480",
      );
      await response.arrayBuffer();

      expect(response.status).toBe(200);
      expect(subscribeCalls[0].input.image_size).toEqual({
        width: 640,
        height: 480,
      });
    });

    it("requests a square image when only the width is given", async () => {
      const response = await app().request("/api/ai/img?prompt=cat&width=640");
      await response.arrayBuffer();

      expect(subscribeCalls[0].input.image_size).toBe("square");
    });

    it("serves a repeated request from the disk cache without generating again", async () => {
      const first = await app().request("/api/ai/img?prompt=cat");
      await first.arrayBuffer();
      const second = await app().request("/api/ai/img?prompt=cat");

      expect(second.status).toBe(200);
      expect(second.headers.get("X-Disk-Cache")).toBe("HIT");
      expect(new Uint8Array(await second.arrayBuffer())).toEqual(IMAGE_BYTES);
      expect(subscribeCalls.length).toBe(1);
      expect(fetchedUrls.length).toBe(1);
    });

    it("keys the cache on the size as well as the prompt", async () => {
      const square = await app().request("/api/ai/img?prompt=cat");
      await square.arrayBuffer();
      const sized = await app().request(
        "/api/ai/img?prompt=cat&width=640&height=480",
      );
      await sized.arrayBuffer();

      expect(sized.headers.get("X-Disk-Cache")).toBe("MISS");
      expect(subscribeCalls.length).toBe(2);
    });

    it("returns 422 without calling the model for a missing prompt or a size outside 64 to 1024", async () => {
      for (
        const query of [
          "",
          "?prompt=cat&width=63&height=480",
          "?prompt=cat&width=640&height=1025",
          "?prompt=cat&width=640.5&height=480",
        ]
      ) {
        const response = await app().request(`/api/ai/img${query}`);
        await response.arrayBuffer();
        expect(response.status).toBe(422);
      }
      expect(subscribeCalls).toEqual([]);
    });

    it("returns 500 and caches nothing when the model returns no image URL", async () => {
      for (
        const data of [undefined, {}, { images: [] }, { images: [{}] }]
      ) {
        generate = () => Promise.resolve({ data });
        const response = await app().request("/api/ai/img?prompt=cat");

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: "Failed to generate image",
        });
      }
      expect(fetchedUrls).toEqual([]);
      await expect(Deno.stat(cacheDir)).rejects.toThrow(Deno.errors.NotFound);
    });

    it("returns 500 and caches nothing when the image download fails", async () => {
      download = () => Promise.resolve(new Response("gone", { status: 404 }));
      const response = await app().request("/api/ai/img?prompt=cat");

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to fetch generated image",
      });
      await expect(Deno.stat(cacheDir)).rejects.toThrow(Deno.errors.NotFound);

      download = () => Promise.resolve(new Response(IMAGE_BYTES));
      const retried = await app().request("/api/ai/img?prompt=cat");
      await retried.arrayBuffer();
      expect(retried.headers.get("X-Disk-Cache")).toBe("MISS");
    });

    it("returns 500 when the model call throws", async () => {
      generate = () => Promise.reject(new Error("quota exceeded"));
      const response = await app().request("/api/ai/img?prompt=cat");

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Image generation failed",
      });
    });
  });

  describe("POST /api/ai/img", () => {
    function post(body: unknown) {
      return app().request("/api/ai/img", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("passes the prompt and every option to the model and serves the image", async () => {
      const response = await post({
        prompt: "cat",
        image_size: "square_hd",
        seed: 7,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Disk-Cache")).toBe("MISS");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        IMAGE_BYTES,
      );
      expect(subscribeCalls.map((call) => call.input)).toEqual([
        { prompt: "cat", image_size: "square_hd", seed: 7 },
      ]);
    });

    it("serves the same options from the cache and generates again for different ones", async () => {
      await (await post({ prompt: "cat", seed: 7 })).arrayBuffer();
      const same = await post({ prompt: "cat", seed: 7 });
      await same.arrayBuffer();
      const different = await post({ prompt: "cat", seed: 8 });
      await different.arrayBuffer();

      expect(same.headers.get("X-Disk-Cache")).toBe("HIT");
      expect(different.headers.get("X-Disk-Cache")).toBe("MISS");
      expect(subscribeCalls.length).toBe(2);
    });

    it("returns 422 without calling the model for an empty prompt or too many images", async () => {
      for (const body of [{ prompt: "" }, { prompt: "cat", num_images: 5 }]) {
        const response = await post(body);
        await response.arrayBuffer();
        expect(response.status).toBe(422);
      }
      expect(subscribeCalls).toEqual([]);
    });

    it("returns 500 when the model returns no image URL", async () => {
      generate = () => Promise.resolve({ data: { images: [] } });
      const response = await post({ prompt: "cat" });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to generate image",
      });
    });
  });
});
