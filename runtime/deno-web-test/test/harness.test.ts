/**
 * The page side of deno-web-test, driven with stand-ins for the page: a
 * document holding the `#title` and `#tests` elements `index.html` has, the
 * page's URL, and an importer standing in for the page's `import()`.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import {
  start,
  Test,
  TestController,
  TestHarness,
} from "../harness/harness.js";

/** The part of an element the harness touches. */
class StandInElement {
  innerText = "";
  readonly attributes = new Map<string, string>();
  readonly children: StandInElement[] = [];

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: StandInElement): void {
    this.children.push(child);
  }
}

/** The part of `index.html`'s document the harness touches. */
class StandInDocument {
  readonly title = new StandInElement();
  readonly tests = new StandInElement();

  querySelector(selector: string): StandInElement {
    switch (selector) {
      case "#title":
        return this.title;
      case "#tests":
        return this.tests;
      default:
        throw new Error(`index.html has no ${selector}`);
    }
  }

  createElement(tag: string): StandInElement {
    if (tag !== "li") throw new Error(`the harness makes no <${tag}>`);
    return new StandInElement();
  }
}

/** A promise with its settlers, for an import that settles when told to. */
function pending() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PAGE = "http://localhost:8000/";

/** A harness for the page `search` names, importing through `importModule`. */
function harnessFor(
  search: string,
  importModule: (url: string) => Promise<unknown> = () => Promise.resolve(),
): { harness: TestHarness; document: StandInDocument } {
  const document = new StandInDocument();
  return {
    harness: new TestHarness(document, `${PAGE}${search}`, importModule),
    document,
  };
}

describe("harness", () => {
  describe("Test", () => {
    describe("run()", () => {
      it("returns a passing result and marks the element a success", async () => {
        const el = new StandInElement();
        const result = await new Test("adds", () => {}, el, 1000).run();
        expect(result.name).toBe("adds");
        expect(result.error).toBeNull();
        expect(result.duration).toBeGreaterThanOrEqual(0);
        expect(el.innerText).toBe("adds");
        expect(el.attributes.get("state")).toBe("success");
      });

      it("returns what a failing test threw and marks the element an error", async () => {
        for (
          const fn of [
            () => {
              throw new RangeError("too far");
            },
            () => Promise.reject(new RangeError("too far")),
          ]
        ) {
          const el = new StandInElement();
          const result = await new Test("fails", fn, el, 1000).run();
          expect(result.error).toMatchObject({
            name: "RangeError",
            message: "too far",
          });
          expect(result.error?.stack).toContain("too far");
          expect(el.attributes.get("state")).toBe("error");
        }
      });

      describe("with a test that never settles", () => {
        let time: FakeTime;

        beforeEach(() => {
          time = new FakeTime();
        });

        afterEach(() => {
          time.restore();
        });

        it("fails the test as stuck once its timeout passes, and not before", async () => {
          const el = new StandInElement();
          const stuck = pending();
          let result: { error: { message: string } | null } | undefined;
          const running = new Test("hangs", () => stuck.promise, el, 1000)
            .run().then((settled) => result = settled);

          await time.tickAsync(999);
          await time.runMicrotasks();
          expect(result).toBeUndefined();
          expect(el.attributes.has("state")).toBe(false);

          await time.tickAsync(1);
          await running;
          expect(result?.error?.message).toMatch(/^Timed out after 1000ms\./);
          expect(el.attributes.get("state")).toBe("error");

          // The test settling after the harness gave up on it surfaces as
          // no unhandled rejection.
          stuck.reject(new Error("settled late"));
          await time.runMicrotasks();
        });
      });
    });
  });

  describe("TestHarness", () => {
    describe("constructor()", () => {
      it("reads the test file and timeout from the page's URL", () => {
        const { harness } = harnessFor("?test=/a.test.js&testTimeout=1500");
        expect(harness.testFile).toBe("/a.test.js");
        expect(harness.testTimeout).toBe(1500);
      });

      it("falls back to the default timeout when the URL gives none", () => {
        for (const search of ["?test=/a.test.js", "?testTimeout=soon"]) {
          expect(harnessFor(search).harness.testTimeout).toBe(40_000);
        }
      });
    });

    describe("instance members", () => {
      describe("load()", () => {
        it("imports the test file from the bundle and titles the page with it", async () => {
          const imported: string[] = [];
          const { harness, document } = harnessFor(
            "?test=/a.test.js",
            (url) => {
              imported.push(url);
              return Promise.resolve();
            },
          );
          expect(await harness.load()).toBeNull();
          expect(imported).toEqual(["/dist/a.test.js"]);
          expect(document.title.innerText).toBe("/a.test.js");
        });

        it("resolves with what the import threw", async () => {
          const thrown = new Error("this file fails as it loads");
          const { harness } = harnessFor(
            "?test=/a.test.js",
            () => Promise.reject(thrown),
          );
          expect(await harness.load()).toBe(thrown);
        });
      });

      describe("addTest()", () => {
        it("lists each test in the page in the order it registered", () => {
          const { harness, document } = harnessFor("?testTimeout=1500");
          const first = () => {};
          const second = () => {};
          harness.addTest("first", first);
          harness.addTest({ name: "second", fn: second });
          expect(harness.tests.map((test: Test) => [test.name, test.fn]))
            .toEqual([["first", first], ["second", second]]);
          expect(harness.tests[1].timeoutMs).toBe(1500);
          expect(document.tests.children.map((el) => el.innerText)).toEqual([
            "first",
            "second",
          ]);
        });
      });

      describe("runAt()", () => {
        it("runs the test registered at the index", async () => {
          const { harness } = harnessFor("");
          const ran: string[] = [];
          harness.addTest("first", () => ran.push("first"));
          harness.addTest("second", () => ran.push("second"));
          expect((await harness.runAt(1))?.name).toBe("second");
          expect(ran).toEqual(["second"]);
        });

        it("returns null for an index no test registered at", async () => {
          const { harness } = harnessFor("");
          harness.addTest("only", () => {});
          expect(await harness.runAt(1)).toBeNull();
        });
      });
    });
  });

  describe("TestController", () => {
    describe("instance members", () => {
      describe("whenReady()", () => {
        it("resolves ok once the test file has loaded, and not before", async () => {
          const importing = pending();
          const { harness } = harnessFor("", () => importing.promise);
          const controller = new TestController(harness, new EventTarget());
          let ready: unknown;
          const waiting = controller.whenReady().then((r: unknown) =>
            ready = r
          );
          await Promise.resolve();
          expect(ready).toBeUndefined();
          importing.resolve();
          await waiting;
          expect(ready).toEqual({ ok: true });
        });

        it("resolves with the message of what the import threw", async () => {
          const { harness } = harnessFor(
            "",
            () => Promise.reject(new Error("this file fails as it loads")),
          );
          const controller = new TestController(harness, new EventTarget());
          expect(await controller.whenReady()).toEqual({
            error: "this file fails as it loads",
          });
        });

        it("resolves with an uncaught error the page raised as it loaded", async () => {
          const importing = pending();
          const scope = new EventTarget();
          const { harness } = harnessFor("", () => importing.promise);
          const controller = new TestController(harness, scope);
          scope.dispatchEvent(
            new ErrorEvent("error", { message: "Uncaught Error: boom" }),
          );
          importing.resolve();
          expect(await controller.whenReady()).toEqual({
            error: "Uncaught Error: boom",
          });
        });
      });

      describe("getTestCount()", () => {
        it("counts the tests registered so far", () => {
          const { harness } = harnessFor("");
          const controller = new TestController(harness, new EventTarget());
          expect(controller.getTestCount()).toEqual({ ok: 0 });
          harness.addTest("one", () => {});
          expect(controller.getTestCount()).toEqual({ ok: 1 });
        });
      });

      describe("runAt()", () => {
        it("returns the result of the test at the index", async () => {
          const { harness } = harnessFor("");
          const controller = new TestController(harness, new EventTarget());
          harness.addTest("one", () => {});
          expect(await controller.runAt(0)).toMatchObject({
            ok: { name: "one", error: null },
          });
          expect(await controller.runAt(1)).toEqual({ ok: null });
        });
      });
    });
  });

  describe("start()", () => {
    it("makes the page a harness for the test file its URL names", async () => {
      const document = new StandInDocument();
      const scope = Object.assign(new EventTarget(), {
        document,
        location: { href: `${PAGE}?test=/no-such.test.js` },
        Deno: undefined as
          | { test: (name: string, fn: () => void) => void }
          | undefined,
        __denoWebTest: undefined as TestController | undefined,
      });
      start(scope);

      expect(document.title.innerText).toBe("/no-such.test.js");
      scope.Deno?.test("registered", () => {});
      expect(scope.__denoWebTest?.getTestCount()).toEqual({ ok: 1 });
      expect(document.tests.children.map((el) => el.innerText)).toEqual([
        "registered",
      ]);

      // Under Deno the page's bundle is nowhere to be found, so the load
      // fails, naming the file it looked for.
      const ready = await scope.__denoWebTest?.whenReady();
      expect(ready?.ok).toBeUndefined();
      expect(ready?.error).toContain("no-such.test.js");
    });
  });
});
