import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRouter, createTestApp } from "@/lib/create-app.ts";
import { createRateLimiter, rateLimit } from "@/middlewares/rate-limit.ts";

describe("rate-limit", () => {
  describe("rateLimit()", () => {
    // .env.test trusts X-Forwarded-For, so each request names its client.
    const from = (client: string) => ({
      headers: { "x-forwarded-for": client },
    });

    // An app behind a limiter allowing one request per client, which counts
    // the requests that reach the handler.
    const limitedRouter = (options?: { code?: string }) => {
      const reached: string[] = [];
      const router = createRouter();
      router.use(
        rateLimit(
          createRateLimiter({ capacity: 1, refillPerSecond: 0, now: () => 0 }),
          options,
        ),
      );
      router.get("/work", (c) => {
        reached.push(c.req.header("x-forwarded-for") ?? "");
        return c.text("done");
      });
      return { app: createTestApp(router), reached };
    };

    it("passes a request within the limit on to the handler", async () => {
      const { app, reached } = limitedRouter();

      const response = await app.request("/work", from("192.0.2.1"));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("done");
      expect(reached).toEqual(["192.0.2.1"]);
    });

    it("returns 429 without reaching the handler once a client is over the limit", async () => {
      const { app, reached } = limitedRouter();
      await app.request("/work", from("192.0.2.1"));

      const refused = await app.request("/work", from("192.0.2.1"));

      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: "Too many requests" });
      expect(reached).toEqual(["192.0.2.1"]);

      // Another client has a bucket of its own.
      const other = await app.request("/work", from("192.0.2.2"));
      expect(other.status).toBe(200);
    });

    it("names the route's refusal code in the 429 when it has one", async () => {
      const { app } = limitedRouter({ code: "donut-quota" });
      await app.request("/work", from("192.0.2.1"));

      const refused = await app.request("/work", from("192.0.2.1"));

      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({
        error: "Too many requests",
        code: "donut-quota",
      });
    });
  });
});
