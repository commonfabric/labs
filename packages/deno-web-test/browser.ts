import { ConsoleEvent, LaunchOptions, Page } from "@astral/astral";
import {
  BOOT_FAILURE_MESSAGE,
  BrowserProcess,
} from "@commonfabric/integration/browser-process";
import { sleep } from "@commonfabric/utils/sleep";

import { DEFAULT_TEST_TIMEOUT_MS, extractAstralConfig } from "./config.ts";
import { TestResult } from "./interface.ts";
import { Manifest } from "./manifest.ts";
import { tsToJs } from "./utils.ts";

const LAUNCH_RETRY_ATTEMPTS = 5;
const LAUNCH_RETRYABLE_ETXTBSY = "Text file busy (os error 26)";

type LaunchFn = (options: LaunchOptions) => Promise<BrowserProcess>;
type SleepFn = (ms: number) => Promise<unknown>;

export function isRetryableAstralLaunchError(error: unknown): boolean {
  return String(error).includes(LAUNCH_RETRYABLE_ETXTBSY) ||
    error instanceof Error && error.message === BOOT_FAILURE_MESSAGE;
}

export async function launchWithRetry(
  options: LaunchOptions,
  launchImpl: LaunchFn = BrowserProcess.start,
  sleepImpl: SleepFn = sleep,
): Promise<BrowserProcess> {
  for (let attempt = 1; attempt <= LAUNCH_RETRY_ATTEMPTS; attempt++) {
    try {
      return await launchImpl(options);
    } catch (error) {
      if (
        attempt === LAUNCH_RETRY_ATTEMPTS ||
        !isRetryableAstralLaunchError(error)
      ) {
        throw error;
      }
      await sleepImpl(250 * 2 ** (attempt - 1));
    }
  }
  throw new Error("unreachable");
}

export class BrowserController extends EventTarget {
  static readonly #HARNESS_READY_TIMEOUT_MS = 10_000;
  static readonly #HARNESS_READY_POLL_MS = 200;
  #manifest: Manifest;
  #page: Page | null;
  #process: BrowserProcess | null;
  #serverPort: number;

  constructor(manifest: Manifest, serverPort: number) {
    super();
    this.#manifest = manifest;
    this.#process = null;
    this.#page = null;
    this.#serverPort = serverPort;
  }

  async load(filePath: string) {
    const rootUrl = `http://localhost:${this.#serverPort}`;
    const jsTestPath = tsToJs(filePath);
    const config = this.#manifest.config;
    const testTimeout = config.testTimeout ?? DEFAULT_TEST_TIMEOUT_MS;
    const testUrl =
      `${rootUrl}/?test=/${jsTestPath}&testTimeout=${testTimeout}`;

    if (this.#page) {
      await this.#page.goto(testUrl);
    } else {
      this.#process = await launchWithRetry(
        extractAstralConfig(config, this.#manifest.profileDir),
      );
      this.#page = await this.#process.newPage(testUrl);
      this.#page.addEventListener("console", (e) => {
        // Not sure why this event needs reconstructed in order
        // to re-fire, rather than just passing it into `dispatchEvent`.
        this.dispatchEvent(
          new ConsoleEvent({
            type: e.detail.type,
            text: e.detail.text,
          }),
        );
      });
    }
    await this.#waitUntilReady();
  }

  async getTestCount(): Promise<number> {
    if (!this.#page) {
      throw new Error("No page loaded.");
    }
    return (await this.#page.evaluate(() =>
      // @ts-ignore This is defined in the JS harness
      globalThis.__denoWebTest.getTestCount()
    ))
      .ok;
  }

  /** Runs the loaded file's test at `index`, numbered as it registered. */
  async runTest(index: number): Promise<TestResult | void> {
    if (!this.#page) {
      throw new Error("No page loaded.");
    }

    return (await this.#page.evaluate((at: number) =>
      // @ts-ignore This is defined in the JS harness
      globalThis.__denoWebTest.runAt(at), { args: [index] })).ok;
  }

  async #waitUntilReady() {
    if (!this.#page) {
      throw new Error("No page loaded.");
    }
    const attempts = Math.ceil(
      BrowserController.#HARNESS_READY_TIMEOUT_MS /
        BrowserController.#HARNESS_READY_POLL_MS,
    );
    for (let i = 0; i < attempts; i++) {
      const response = await this.#page.evaluate(() =>
        // @ts-ignore This is defined in the JS harness
        globalThis.__denoWebTest && globalThis.__denoWebTest.isReady()
      );
      if (response.ok) {
        return;
      }
      if (response.error) {
        throw new Error(response.error?.message ?? response.error);
      }
      await sleep(BrowserController.#HARNESS_READY_POLL_MS);
    }
    throw new Error(
      `Test harness not ready in ${BrowserController.#HARNESS_READY_TIMEOUT_MS}ms.`,
    );
  }

  async close() {
    this.#page = null;
    if (this.#process) {
      await this.#process.close();
    }
    this.#process = null;
  }
}
