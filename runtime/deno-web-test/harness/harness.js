const $ = document.querySelector.bind(document);
const formatError = (e) => ({
  name: e.name,
  message: e.message,
  stack: e.stack,
});

class Test {
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
      // running in the page after this returns. Keep a handler on it either
      // way, so that settling late does not surface as an unhandled rejection
      // against whichever test is running by then.
      const running = (async () => await this.fn())();
      running.catch(() => {});
      await Promise.race([running, this.#stuck()]);
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

class TestController {
  constructor(harness) {
    this.harness = harness;
    this.globalError = null;
    globalThis.addEventListener("error", (e) => this.onGlobalError(e));
  }

  isReady() {
    if (this.globalError) {
      return { error: this.globalError };
    }
    const loadError = this.harness.getLoadError();
    if (loadError) {
      return { error: loadError.message };
    }
    return { ok: this.harness.ready() };
  }

  getTestCount() {
    return { ok: this.harness.tests.length };
  }

  async runAt(index) {
    return { ok: await this.harness.runAt(index) };
  }

  onGlobalError(e) {
    this.globalError = formatError(e);
  }
}

class TestHarness {
  constructor() {
    const params = new URL(globalThis.location.href).searchParams;
    this.testFile = params.get("test");
    // `BrowserController` always sends this; the fallback only covers the page
    // being opened by hand. Keep it in step with `DEFAULT_TEST_TIMEOUT_MS`,
    // which this file cannot import.
    this.testTimeout = Number(params.get("testTimeout")) || 40_000;
    this.tests = [];
    this.loadError = null;
    this._ready = false;
  }

  ready() {
    return this._ready;
  }

  getLoadError() {
    return this.loadError;
  }

  async load() {
    $("#title").innerText = this.testFile;
    try {
      await import(`/dist${this.testFile}`);
    } catch (e) {
      this.loadError = e;
      return;
    }
    this._ready = true;
  }

  addTest(name, fn) {
    if (typeof name === "object" && name.name) {
      // Attempt to support BDD-style and Deno.test
      // objects with config, though not complete
      const object = name;
      name = object.name;
      fn = object.fn;
    }
    const el = document.createElement("li");
    $("#tests").appendChild(el);
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

const harness = new TestHarness();
const controller = new TestController(harness);
globalThis.__denoWebTest = controller;

globalThis.Deno = Object.create(null);
globalThis.Deno.test = harness.addTest.bind(harness);
harness.load();
