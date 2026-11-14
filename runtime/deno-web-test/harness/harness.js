// The page side of deno-web-test. `index.html` calls `start()`, which loads
// the test file the page's URL names and answers the driver's questions about
// it through `globalThis.__denoWebTest`. Nothing here runs on import, so a
// Deno test can import this module and drive it with stand-ins for the page.

const formatError = (e) => ({
  name: e.name,
  message: e.message,
  stack: e.stack,
});

export class Test {
  constructor(name, fn, el, timeoutMs) {
    this.name = name;
    this.fn = fn;
    this.timeoutMs = timeoutMs;
    this.success = null;
    this.duration = null;
    this.error = null;
    this.el = el;
    this.el.innerText = name;
  }

  // Rejects once the test has run for `timeoutMs` without finishing. A test
  // that waits on an event which never arrives would otherwise sit here until
  // the driver's own deadline killed the whole run without naming it.
  #stuck() {
    return new Promise((_, reject) => {
      this.timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${this.timeoutMs}ms. The harness stops waiting on ` +
              `a test at that point and calls it stuck; it is not a bound on ` +
              `how long a test may legitimately take. Either this test is ` +
              `waiting for something that never arrived, or the suite needs a ` +
              `larger \`testTimeout\` in its deno-web-test.config.ts.`,
          ),
        );
      }, this.timeoutMs);
    });
  }

  async run() {
    const start = performance.now();
    try {
      // Nothing can cancel the test's own promise, so a stuck test goes on
      // running in the page after this returns. The race keeps a handler on
      // it, so settling late does not surface as an unhandled rejection
      // against whichever test is running by then.
      await Promise.race([(async () => await this.fn())(), this.#stuck()]);
      this.success = true;
      this.el.setAttribute("state", "success");
    } catch (e) {
      this.success = false;
      this.error = formatError(e);
      this.el.setAttribute("state", "error");
    } finally {
      clearTimeout(this.timer);
    }
    this.duration = performance.now() - start;
    // This matches `TestResult` in typescript
    return {
      name: this.name,
      error: this.error,
      duration: this.duration,
    };
  }
}

// What the driver calls in the page. `scope` is the page's global object,
// whose uncaught errors fail the load.
export class TestController {
  constructor(harness, scope) {
    this.harness = harness;
    this.globalError = null;
    scope.addEventListener("error", (e) => this.onGlobalError(e));
    this.loading = harness.load();
  }

  // Resolves once the test file has loaded, with `{ ok: true }`, or with the
  // message of what went wrong as `{ error }`.
  async whenReady() {
    const loadError = await this.loading;
    if (this.globalError) {
      return { error: this.globalError };
    }
    if (loadError !== null) {
      return { error: loadError };
    }
    return { ok: true };
  }

  getTestCount() {
    return { ok: this.harness.tests.length };
  }

  async runAt(index) {
    return { ok: await this.harness.runAt(index) };
  }

  onGlobalError(e) {
    this.globalError = e.message;
  }
}

// The test file the page at `href` names and the tests it registers, each
// listed in `document`. `importModule` imports a module by its URL.
export class TestHarness {
  constructor(document, href, importModule) {
    const params = new URL(href).searchParams;
    this.document = document;
    this.importModule = importModule;
    this.testFile = params.get("test");
    // `BrowserController` always sends this; the fallback only covers the page
    // being opened by hand. Keep it in step with `DEFAULT_TEST_TIMEOUT_MS`,
    // which this file cannot import.
    this.testTimeout = Number(params.get("testTimeout")) || 40_000;
    this.tests = [];
  }

  // Imports the test file, resolving with the message of what its import
  // threw, whatever was thrown, or with `null` once it has loaded.
  async load() {
    this.document.querySelector("#title").innerText = this.testFile;
    try {
      await this.importModule(`/dist${this.testFile}`);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return null;
  }

  addTest(name, fn) {
    if (typeof name === "object" && name.name) {
      // Attempt to support BDD-style and Deno.test
      // objects with config, though not complete
      const object = name;
      name = object.name;
      fn = object.fn;
    }
    const el = this.document.createElement("li");
    this.document.querySelector("#tests").appendChild(el);
    this.tests.push(new Test(name, fn, el, this.testTimeout));
  }

  // The driver chooses which test runs next, and in what order; a file's
  // tests are numbered here in the order they registered.
  async runAt(index) {
    const test = this.tests[index];
    if (!test) {
      return null;
    }
    return await test.run();
  }
}

// Makes the page `scope` a deno-web-test harness: gives it a `Deno.test` that
// registers with the harness, the controller the driver calls, and starts
// loading the test file its URL names.
export function start(scope) {
  const harness = new TestHarness(
    scope.document,
    scope.location.href,
    (url) => import(url),
  );
  scope.Deno = Object.create(null);
  scope.Deno.test = harness.addTest.bind(harness);
  scope.__denoWebTest = new TestController(harness, scope);
}
