import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { MEMORY_URL_META_NAME } from "@commonfabric/runner/deployment-meta";
import type { DeploymentMemoryUrl } from "@commonfabric/runner/deployment-meta";

import {
  holdMemoryUrl,
  memoryUrlFromPage,
  resolveMemoryUrl,
} from "../src/lib/memory-url.ts";

/** A page whose memory URL element carries `content`, or none. */
function pageWithMemoryUrl(content: string | undefined) {
  return {
    querySelector: (selector: string) =>
      content !== undefined &&
        selector === `meta[name="${MEMORY_URL_META_NAME}"]`
        ? {
          getAttribute: (name: string) => name === "content" ? content : null,
        }
        : null,
  } as unknown as Pick<ParentNode, "querySelector">;
}

/** A `fetch` returning `body` with `status`, recording each URL asked for. */
function serving(fetched: string[], body: unknown, status = 200) {
  return (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return Promise.resolve(Response.json(body, { status }));
  };
}

const api = new URL("https://app.test/");
const origin = "https://app.test";

describe("memory-url", () => {
  describe("memoryUrlFromPage()", () => {
    it("returns the element's memory URL for a page served from the API URL's origin", () => {
      expect(
        memoryUrlFromPage(
          pageWithMemoryUrl("https://router.test"),
          api,
          origin,
        ),
      ).toEqual({ from: "page", memoryUrl: new URL("https://router.test/") });
    });

    it("returns no memory URL for an empty element, or one naming the API URL's origin", () => {
      // An empty element is the deployment saying it has none.
      for (const value of ["", "https://app.test"]) {
        expect(memoryUrlFromPage(pageWithMemoryUrl(value), api, origin))
          .toEqual({ from: "page", memoryUrl: undefined });
      }
    });

    it("defers to the deployment for a page without the element", () => {
      expect(memoryUrlFromPage(undefined, api, origin))
        .toEqual({ from: "deployment" });
      expect(memoryUrlFromPage(pageWithMemoryUrl(undefined), api, origin))
        .toEqual({ from: "deployment" });
    });

    it("defers to the deployment for a page served from another origin", () => {
      // A CDN copy with a built-in API URL: the element, if any, describes the
      // host that served the page, not the API URL's deployment.
      expect(
        memoryUrlFromPage(
          pageWithMemoryUrl("https://router.test"),
          api,
          "https://cdn.test",
        ),
      ).toEqual({ from: "deployment" });
    });

    it("logs a malformed element and defers to the deployment", () => {
      using error = stub(console, "error");
      for (const value of ["router.test", "https://router.test/api"]) {
        expect(memoryUrlFromPage(pageWithMemoryUrl(value), api, origin))
          .toEqual({ from: "deployment" });
      }
      expect(error.calls.length).toBe(2);
      expect(String(error.calls[0].args[0])).toContain('"router.test"');
    });
  });

  describe("resolveMemoryUrl()", () => {
    it("returns the page's memory URL, not transient, without a request", async () => {
      const fetched: string[] = [];
      const fetch = serving(fetched, { memoryUrl: "https://other.test" });
      const fromPage = await resolveMemoryUrl(
        pageWithMemoryUrl("https://router.test"),
        api,
        origin,
        fetch,
      );
      expect(fromPage.memoryUrl?.href).toBe("https://router.test/");
      expect(fromPage.transient).toBe(false);
      expect(
        await resolveMemoryUrl(pageWithMemoryUrl(""), api, origin, fetch),
      ).toEqual({ memoryUrl: undefined, transient: false });
      expect(fetched).toEqual([]);
    });

    it("returns the memory URL the API URL's meta document publishes when the page states none", async () => {
      const fetched: string[] = [];
      const fromDeployment = await resolveMemoryUrl(
        pageWithMemoryUrl("https://router.test"),
        api,
        "https://cdn.test",
        serving(fetched, { memoryUrl: "https://api-router.test" }),
      );
      expect(fromDeployment.memoryUrl?.href).toBe("https://api-router.test/");
      expect(fromDeployment.transient).toBe(false);
      expect(fetched).toEqual(["https://app.test/api/meta"]);
    });

    it("returns no memory URL, not transient, from a server without the meta route", async () => {
      expect(
        await resolveMemoryUrl(undefined, api, origin, serving([], {}, 404)),
      ).toEqual({ memoryUrl: undefined, transient: false });
    });

    it("reads the meta document for a page whose element is malformed", async () => {
      using _error = stub(console, "error");
      const fetched: string[] = [];
      const read = await resolveMemoryUrl(
        pageWithMemoryUrl("https://router.test/api"),
        api,
        origin,
        serving(fetched, { memoryUrl: "https://router.test" }),
      );
      expect(read.memoryUrl?.href).toBe("https://router.test/");
      expect(fetched).toEqual(["https://app.test/api/meta"]);
    });

    it("returns no memory URL, not transient, when the server refuses the meta document", async () => {
      using _warn = stub(console, "warn");
      expect(
        await resolveMemoryUrl(undefined, api, origin, serving([], {}, 500)),
      ).toEqual({ memoryUrl: undefined, transient: false });
    });
  });

  describe("holdMemoryUrl()", () => {
    const router = new URL("https://router.test");
    const published: DeploymentMemoryUrl = {
      memoryUrl: router,
      transient: false,
    };
    const transientFailure: DeploymentMemoryUrl = {
      memoryUrl: undefined,
      transient: true,
    };

    /** A `read` returning `results` in turn, counting the reads. */
    function reading(...results: Promise<DeploymentMemoryUrl>[]) {
      const counts = { reads: 0 };
      return { counts, read: () => results[counts.reads++] };
    }

    it("reads once while the result is not transient, however long the page lives", async () => {
      let clock = 0;
      const { counts, read } = reading(Promise.resolve(published));
      const memoryUrl = holdMemoryUrl(read, () => clock);
      memoryUrl.prefetch();
      expect(await memoryUrl.get()).toBe(router);
      clock = 60_000;
      expect(await memoryUrl.get()).toBe(router);
      expect(counts.reads).toBe(1);
    });

    it("keeps a failure that is not transient, and reads once, however long the page lives", async () => {
      // A 401 or a 500 would fail the same way again, and warn again.
      let clock = 0;
      const { counts, read } = reading(
        Promise.resolve({ memoryUrl: undefined, transient: false }),
        Promise.resolve(published),
      );
      const memoryUrl = holdMemoryUrl(read, () => clock);
      memoryUrl.prefetch();
      await Promise.resolve();
      clock = 60_000;
      expect(await memoryUrl.get()).toBeUndefined();
      expect(await memoryUrl.get()).toBeUndefined();
      expect(counts.reads).toBe(1);
    });

    it("gives a transient failure the page read at load to the first get within ten seconds, then reads again", async () => {
      let clock = 0;
      const { counts, read } = reading(
        Promise.resolve(transientFailure),
        Promise.resolve(published),
      );
      const memoryUrl = holdMemoryUrl(read, () => clock);
      memoryUrl.prefetch();
      // Settled before anything asks for it, as a page's read can be.
      await Promise.resolve();
      clock = 9_999;
      expect(await memoryUrl.get()).toBeUndefined();
      expect(counts.reads).toBe(1);
      expect(await memoryUrl.get()).toBe(router);
      expect(await memoryUrl.get()).toBe(router);
      expect(counts.reads).toBe(2);
    });

    it("reads again for the first get when the page's transient failure is ten seconds old", async () => {
      // A user who took longer to sign in than the toolshed took to restart.
      let clock = 0;
      const { counts, read } = reading(
        Promise.resolve(transientFailure),
        Promise.resolve(published),
      );
      const memoryUrl = holdMemoryUrl(read, () => clock);
      memoryUrl.prefetch();
      await Promise.resolve();
      clock = 10_000;
      expect(await memoryUrl.get()).toBe(router);
      expect(counts.reads).toBe(2);
    });

    it("gives the page's read to the first get while it is pending, however long it has been", async () => {
      let clock = 0;
      const pending = Promise.withResolvers<DeploymentMemoryUrl>();
      const { counts, read } = reading(
        pending.promise,
        Promise.resolve(published),
      );
      const memoryUrl = holdMemoryUrl(read, () => clock);
      memoryUrl.prefetch();
      clock = 60_000;
      const first = memoryUrl.get();
      pending.resolve(transientFailure);
      expect(await first).toBeUndefined();
      expect(counts.reads).toBe(1);
    });

    it("gives one transient failure to every get that awaited it", async () => {
      let reads = 0;
      const memoryUrl = holdMemoryUrl(() => {
        reads++;
        return Promise.resolve(transientFailure);
      });
      await Promise.all([memoryUrl.get(), memoryUrl.get()]);
      expect(reads).toBe(1);
      await memoryUrl.get();
      expect(reads).toBe(2);
    });

    it("keeps the newer read when a get resumes on a transient failure another get found stale", async () => {
      let clock = 0;
      const { counts, read } = reading(
        Promise.resolve(transientFailure),
        Promise.resolve(published),
      );
      const memoryUrl = holdMemoryUrl(read, () => clock);
      memoryUrl.prefetch();
      await Promise.resolve();
      clock = 9_999;
      // Takes the page's failure, which is still fresh, and resumes later.
      const older = memoryUrl.get();
      clock = 10_000;
      // Finds the same failure stale and starts a read of its own.
      const newer = memoryUrl.get();
      expect(await older).toBeUndefined();
      expect(await newer).toBe(router);
      // The older get did not drop the newer read.
      expect(await memoryUrl.get()).toBe(router);
      expect(counts.reads).toBe(2);
    });
  });
});
