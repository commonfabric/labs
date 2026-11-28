// Run by `../registration.test.ts` as a test file of its own, with the
// argument `FIXTURE_CASE` saying which case.

import { afterAll, beforeAll, describe, it, test } from "../../src/testing.ts";

const scenario = Deno.env.get("FIXTURE_CASE");

if (scenario === "step") {
  describe("group", () => {
    it("rejects without awaiting", () => {
      Promise.reject(new Error("nobody awaited this"));
    });
    it("after", () => {});
  });
} else if (scenario === "handled") {
  test("handles its own rejection", async () => {
    const handled = Promise.withResolvers<void>();
    const handle = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      globalThis.removeEventListener("unhandledrejection", handle);
      handled.resolve();
    };
    globalThis.addEventListener("unhandledrejection", handle);
    Promise.reject(new Error("handled"));
    await handled.promise;
  });
  test("after", () => {});
} else if (scenario === "setup") {
  beforeAll(() => {
    Promise.reject(new Error("the setup left this"));
  });
  test("one", () => {});
} else if (scenario === "group-hangs") {
  describe("group", () => {
    afterAll(async () => {
      await new Promise(() => {});
    });
    it("passes", () => {});
  });
} else if (scenario === "between") {
  let later: ((reason: Error) => void) | undefined;
  test("leaves a promise to reject later", () => {
    new Promise((_, reject) => later = reject);
  });
  afterAll(() => later?.(new Error("rejected while no test ran")));
} else if (scenario === "late") {
  test("one", () => {});
  afterAll(() => {});
  // Added after the test module's own listener, so it runs once the module
  // has written what it had.
  globalThis.addEventListener("unload", () => {
    globalThis.dispatchEvent(
      new ErrorEvent("error", { error: new Error("thrown as the file ended") }),
    );
  });
} else if (scenario === "abandoned") {
  let later: ((reason: Error) => void) | undefined;
  test("waits forever", async () => {
    await new Promise(() => {});
  });
  test("leaves a promise to reject later", () => {
    new Promise((_, reject) => later = reject);
  });
  afterAll(() => later?.(new Error("rejected while no test ran")));
} else if (scenario === "setup-hangs") {
  beforeAll(async () => {
    await new Promise(() => {});
  });
  test("one", () => {});
} else if (scenario === "teardown-hangs") {
  afterAll(async () => {
    await new Promise(() => {});
  });
  test("one", () => {});
} else if (scenario === "group-setup") {
  describe("group", () => {
    beforeAll(() => {
      Promise.reject(new Error("the group's setup left this"));
    });
    it("is innocent", () => {});
  });
} else if (scenario === "nested-hang") {
  describe("outer", () => {
    afterAll(() => {});
    describe("inner", () => {
      it("waits forever", async () => {
        await new Promise(() => {});
      });
    });
  });
} else if (scenario === "killed") {
  beforeAll(() => {});
  test("kills its own process", async () => {
    Deno.kill(Deno.pid, "SIGKILL");
    // The signal arrives asynchronously; the test never settles, so the
    // process ends before it can record the test.
    await new Promise<never>(() => {});
  });
} else if (scenario === "late-handled") {
  test("one", () => {});
  afterAll(() => {});
  // Registered as the file loads, before the module's listeners for the end
  // of the file, so it has the late error first and handles it.
  globalThis.addEventListener("error", (event) => event.preventDefault());
  globalThis.addEventListener("unload", () => {
    globalThis.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("handled as the file ended"),
        cancelable: true,
      }),
    );
  });
} else if (scenario === "after-hang") {
  test("waits forever", async () => {
    await new Promise(() => {});
  });
  test("rejects without awaiting", () => {
    Promise.reject(new Error("nobody awaited this"));
  });
} else {
  test("rejects without awaiting", () => {
    Promise.reject(new Error("nobody awaited this"));
  });
  test("after", () => {});
}
