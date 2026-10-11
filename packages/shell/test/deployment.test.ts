import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  DEPLOYMENT_META_NAME,
  type DeploymentForShell,
  type DeploymentMetaContent,
} from "@commonfabric/runner/deployment-meta";

import {
  deploymentFromPage,
  holdDeployment,
  resolveDeployment,
} from "../src/lib/deployment.ts";

/** A page whose deployment element carries `content`, or none. */
function pageWithContent(content: string | undefined) {
  return {
    querySelector: (selector: string) =>
      content !== undefined &&
        selector === `meta[name="${DEPLOYMENT_META_NAME}"]`
        ? {
          getAttribute: (name: string) => name === "content" ? content : null,
        }
        : null,
  } as unknown as Pick<ParentNode, "querySelector">;
}

/** A page whose element carries `page`, as a compiled toolshed writes it. */
const pageWith = (page: Partial<DeploymentMetaContent>) =>
  pageWithContent(JSON.stringify(page));

/** A `fetch` returning `body` with `status`, recording each URL asked for. */
function serving(fetched: string[], body: unknown, status = 200) {
  return (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return Promise.resolve(Response.json(body, { status }));
  };
}

const api = new URL("https://app.test/");
const origin = "https://app.test";

describe("deployment", () => {
  describe("deploymentFromPage()", () => {
    it("returns the element's memory URL and flags for a page served from the API URL's origin", () => {
      for (const sharedMemoryConnection of [true, false]) {
        expect(
          deploymentFromPage(
            pageWith({
              memoryUrl: "https://router.test",
              experimental: { sharedMemoryConnection },
            }),
            api,
            origin,
          ),
        ).toEqual({
          from: "page",
          memoryUrl: new URL("https://router.test/"),
          experimental: { sharedMemoryConnection },
        });
      }
    });

    it("returns no memory URL for a null, or one naming the API URL's origin", () => {
      // A null is the deployment saying it has none.
      for (const memoryUrl of [null, "https://app.test"]) {
        expect(
          deploymentFromPage(
            pageWith({ memoryUrl, experimental: {} }),
            api,
            origin,
          ),
        ).toEqual({ from: "page", memoryUrl: undefined, experimental: {} });
      }
    });

    it("reads a missing memoryUrl as null", () => {
      // Only a page a toolshed did not write can lack the field.
      expect(
        deploymentFromPage(
          pageWith({ experimental: { sharedMemoryConnection: true } }),
          api,
          origin,
        ),
      ).toEqual({
        from: "page",
        memoryUrl: undefined,
        experimental: { sharedMemoryConnection: true },
      });
    });

    it("declares no flag from an element without a posture, or with other flags", () => {
      for (
        const page of [
          { memoryUrl: null, experimental: null },
          { memoryUrl: null },
          { memoryUrl: null, experimental: { serverExecution: true } },
        ]
      ) {
        expect(
          deploymentFromPage(pageWith(page), api, origin),
          JSON.stringify(page),
        )
          .toEqual({ from: "page", memoryUrl: undefined, experimental: {} });
      }
    });

    it("drops a flag declared with a non-boolean, with a warning, and keeps the rest", () => {
      using warn = stub(console, "warn");
      expect(
        deploymentFromPage(
          pageWith({
            memoryUrl: "https://router.test",
            experimental: {
              sharedMemoryConnection: "true" as unknown as boolean,
            },
          }),
          api,
          origin,
        ),
      ).toEqual({
        from: "page",
        memoryUrl: new URL("https://router.test/"),
        experimental: {},
      });
      expect(warn.calls.length).toBe(1);
    });

    it("defers to the deployment for a page without the element", () => {
      expect(deploymentFromPage(undefined, api, origin))
        .toEqual({ from: "deployment" });
      expect(deploymentFromPage(pageWithContent(undefined), api, origin))
        .toEqual({ from: "deployment" });
    });

    it("defers to the deployment for a page served from another origin", () => {
      // A CDN copy with a built-in API URL: the element, if any, describes the
      // host that served the page, not the API URL's deployment.
      expect(
        deploymentFromPage(
          pageWith({
            memoryUrl: "https://router.test",
            experimental: { sharedMemoryConnection: true },
          }),
          api,
          "https://cdn.test",
        ),
      ).toEqual({ from: "deployment" });
    });

    it("logs an element that is not a JSON object and defers to the deployment", () => {
      using error = stub(console, "error");
      for (
        const content of [
          "",
          "https://router.test",
          "{",
          "null",
          "[]",
          '"https://router.test"',
        ]
      ) {
        expect(
          deploymentFromPage(pageWithContent(content), api, origin),
          content,
        )
          .toEqual({ from: "deployment" });
      }
      expect(error.calls.length).toBe(6);
      expect(String(error.calls[1].args[0])).toContain(
        '"https://router.test" (not a JSON object)',
      );
    });

    it("logs a malformed memory URL and defers to the deployment", () => {
      using error = stub(console, "error");
      for (const memoryUrl of ["router.test", "https://router.test/api"]) {
        expect(
          deploymentFromPage(
            pageWith({ memoryUrl, experimental: {} }),
            api,
            origin,
          ),
        ).toEqual({ from: "deployment" });
      }
      expect(error.calls.length).toBe(2);
      expect(String(error.calls[0].args[0])).toContain("router.test");
    });
  });

  describe("resolveDeployment()", () => {
    it("returns the page's deployment, not transient, without a request", async () => {
      const fetched: string[] = [];
      const fetch = serving(fetched, {
        memoryUrl: "https://other.test",
        experimental: { sharedMemoryConnection: false },
      });
      const fromPage = await resolveDeployment(
        pageWith({
          memoryUrl: "https://router.test",
          experimental: { sharedMemoryConnection: true },
        }),
        api,
        origin,
        fetch,
      );
      expect(fromPage.memoryUrl?.href).toBe("https://router.test/");
      expect(fromPage.experimental).toEqual({ sharedMemoryConnection: true });
      expect(fromPage.transient).toBe(false);
      expect(
        await resolveDeployment(
          pageWith({ memoryUrl: null, experimental: null }),
          api,
          origin,
          fetch,
        ),
      ).toEqual({ memoryUrl: undefined, experimental: {}, transient: false });
      expect(fetched).toEqual([]);
    });

    it("reads the memory URL and the flags from one request to the API URL's meta document when the page states none", async () => {
      const fetched: string[] = [];
      const fromDeployment = await resolveDeployment(
        pageWith({
          memoryUrl: "https://router.test",
          experimental: { sharedMemoryConnection: false },
        }),
        api,
        "https://cdn.test",
        serving(fetched, {
          memoryUrl: "https://api-router.test",
          experimental: { sharedMemoryConnection: true, serverExecution: true },
        }),
      );
      expect(fromDeployment.memoryUrl?.href).toBe("https://api-router.test/");
      expect(fromDeployment.experimental).toEqual({
        sharedMemoryConnection: true,
      });
      expect(fromDeployment.transient).toBe(false);
      expect(fetched).toEqual(["https://app.test/api/meta"]);
    });

    it("reads the meta document for a page without the element", async () => {
      const fetched: string[] = [];
      const read = await resolveDeployment(
        undefined,
        api,
        origin,
        serving(fetched, { experimental: { sharedMemoryConnection: true } }),
      );
      expect(read).toEqual({
        memoryUrl: undefined,
        experimental: { sharedMemoryConnection: true },
        transient: false,
      });
      expect(fetched).toEqual(["https://app.test/api/meta"]);
    });

    it("returns nothing, not transient, from a server without the meta route", async () => {
      expect(
        await resolveDeployment(undefined, api, origin, serving([], {}, 404)),
      ).toEqual({ memoryUrl: undefined, experimental: {}, transient: false });
    });

    it("reads the meta document for a page whose element is malformed", async () => {
      using _error = stub(console, "error");
      for (
        const page of [
          pageWithContent("not json"),
          pageWith({ memoryUrl: "https://router.test/api", experimental: {} }),
        ]
      ) {
        const fetched: string[] = [];
        const read = await resolveDeployment(
          page,
          api,
          origin,
          serving(fetched, {
            memoryUrl: "https://router.test",
            experimental: { sharedMemoryConnection: true },
          }),
        );
        expect(read.memoryUrl?.href).toBe("https://router.test/");
        expect(read.experimental).toEqual({ sharedMemoryConnection: true });
        expect(fetched).toEqual(["https://app.test/api/meta"]);
      }
    });

    it("returns nothing, not transient, when the server refuses the meta document", async () => {
      using _warn = stub(console, "warn");
      expect(
        await resolveDeployment(undefined, api, origin, serving([], {}, 500)),
      ).toEqual({ memoryUrl: undefined, experimental: {}, transient: false });
    });
  });

  describe("holdDeployment()", () => {
    const router = new URL("https://router.test");
    const published: DeploymentForShell = {
      memoryUrl: router,
      experimental: { sharedMemoryConnection: true },
      transient: false,
    };
    const deployment = {
      memoryUrl: router,
      experimental: { sharedMemoryConnection: true },
    };
    const transientFailure: DeploymentForShell = {
      memoryUrl: undefined,
      experimental: {},
      transient: true,
    };
    const nothing = { memoryUrl: undefined, experimental: {} };

    /** A `read` returning `results` in turn, counting the reads. */
    function reading(...results: Promise<DeploymentForShell>[]) {
      const counts = { reads: 0 };
      return { counts, read: () => results[counts.reads++] };
    }

    it("reads once while the result is not transient, however long the page lives", async () => {
      let clock = 0;
      const { counts, read } = reading(Promise.resolve(published));
      const held = holdDeployment(read, () => clock);
      held.prefetch();
      expect(await held.get()).toEqual(deployment);
      clock = 60_000;
      expect(await held.get()).toEqual(deployment);
      expect(counts.reads).toBe(1);
    });

    it("keeps a failure that is not transient, and reads once, however long the page lives", async () => {
      // A 401 or a 500 would fail the same way again, and warn again.
      let clock = 0;
      const { counts, read } = reading(
        Promise.resolve({
          memoryUrl: undefined,
          experimental: {},
          transient: false,
        }),
        Promise.resolve(published),
      );
      const held = holdDeployment(read, () => clock);
      held.prefetch();
      await Promise.resolve();
      clock = 60_000;
      expect(await held.get()).toEqual(nothing);
      expect(await held.get()).toEqual(nothing);
      expect(counts.reads).toBe(1);
    });

    it("gives a transient failure the page read at load to the first get within ten seconds, then reads again", async () => {
      let clock = 0;
      const { counts, read } = reading(
        Promise.resolve(transientFailure),
        Promise.resolve(published),
      );
      const held = holdDeployment(read, () => clock);
      held.prefetch();
      // Settled before anything asks for it, as a page's read can be.
      await Promise.resolve();
      clock = 9_999;
      expect(await held.get()).toEqual(nothing);
      expect(counts.reads).toBe(1);
      expect(await held.get()).toEqual(deployment);
      expect(await held.get()).toEqual(deployment);
      expect(counts.reads).toBe(2);
    });

    it("reads again for the first get when the page's transient failure is ten seconds old", async () => {
      // A user who took longer to sign in than the toolshed took to restart.
      let clock = 0;
      const { counts, read } = reading(
        Promise.resolve(transientFailure),
        Promise.resolve(published),
      );
      const held = holdDeployment(read, () => clock);
      held.prefetch();
      await Promise.resolve();
      clock = 10_000;
      expect(await held.get()).toEqual(deployment);
      expect(counts.reads).toBe(2);
    });

    it("gives the page's read to the first get while it is pending, however long it has been", async () => {
      let clock = 0;
      const pending = Promise.withResolvers<DeploymentForShell>();
      const { counts, read } = reading(
        pending.promise,
        Promise.resolve(published),
      );
      const held = holdDeployment(read, () => clock);
      held.prefetch();
      clock = 60_000;
      const first = held.get();
      pending.resolve(transientFailure);
      expect(await first).toEqual(nothing);
      expect(counts.reads).toBe(1);
    });

    it("gives one transient failure to every get that awaited it", async () => {
      let reads = 0;
      const held = holdDeployment(() => {
        reads++;
        return Promise.resolve(transientFailure);
      });
      await Promise.all([held.get(), held.get()]);
      expect(reads).toBe(1);
      await held.get();
      expect(reads).toBe(2);
    });

    it("keeps the newer read when a get resumes on a transient failure another get found stale", async () => {
      let clock = 0;
      const { counts, read } = reading(
        Promise.resolve(transientFailure),
        Promise.resolve(published),
      );
      const held = holdDeployment(read, () => clock);
      held.prefetch();
      await Promise.resolve();
      clock = 9_999;
      // Takes the page's failure, which is still fresh, and resumes later.
      const older = held.get();
      clock = 10_000;
      // Finds the same failure stale and starts a read of its own.
      const newer = held.get();
      expect(await older).toEqual(nothing);
      expect(await newer).toEqual(deployment);
      // The older get did not drop the newer read.
      expect(await held.get()).toEqual(deployment);
      expect(counts.reads).toBe(2);
    });
  });
});
