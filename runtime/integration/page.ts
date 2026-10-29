import { ensureDirSync } from "@std/fs";
import * as path from "@std/path";

import {
  ConsoleEvent,
  DialogEvent,
  ElementHandle as AstralElementHandle,
  EvaluateFunction,
  EvaluateOptions,
  Keyboard,
  KeyboardTypeOptions,
  Page as AstralPage,
  PageEventMap,
  ScreenshotOptions,
  WaitForOptions,
  WaitForSelectorOptions,
} from "@astral/astral";
import { sleep } from "@commonfabric/utils/sleep";
import { Mutable } from "@commonfabric/utils/types";

import type {
  ElementHandle,
  InteractionObserver,
  ScreencastFrame,
  SelectorOptions,
} from "./astral-adapter.ts";
import {
  measureRetainedContentQuad,
  queryAllPierce,
  queryPierce,
  waitForPierceSelector,
} from "./astral-adapter.ts";
import { ConsoleMethod } from "./console.ts";

export interface NavigationOptions {
  waitUntil?: "load" | "none";
  referrer?: string;
}

// To handle `console` events from `Page`, logging to outer context:
//
// ```ts
// page.addEventListener("console", pipeConsole);
// ```
export function pipeConsole(e: ConsoleEvent) {
  console.log(`Browser Console [${e.detail.type}]: ${e.detail.text}`);
}

// To handle `dialog` events from `Page`, automatically dismissing.
//
// ```ts
// page.addEventListener("dialog", dismissDialogs);
// ```
//
// A beforeunload confirmation is accepted ("Leave") rather than dismissed:
// dismissing it cancels the navigation the test just requested, which then
// times out. The shell raises this dialog when a reload would drop writes the
// server has not yet confirmed; a test that navigates at that point means to
// navigate anyway, and durability assertions belong to the runtime-idle
// checkpoint, not to this prompt.
export async function dismissDialogs(e: DialogEvent) {
  const dialog = e.detail;
  console.log(`Browser Dialog: ${dialog.type} - ${dialog.message}`);
  if (dialog.type === "beforeunload") {
    await dialog.accept();
  } else {
    await dialog.dismiss();
  }
}

// Wrapper around `@astral/astral`'s `Page`.
export class Page extends EventTarget {
  #page: AstralPage | null;
  #timeout: number;
  #afterNavigation: Array<() => Promise<void> | void> = [];
  #beforeUnload: Array<() => Promise<void> | void> = [];
  #interactionObserver?: InteractionObserver;
  #defaultTypeDelay = 0;
  #decoratedElements = new WeakSet<AstralElementHandle>();
  #patchedKeyboard?: Keyboard;
  #originalKeyboardType?: Keyboard["type"];
  #navigationQueue: Promise<void> = Promise.resolve();

  constructor(page: AstralPage, options: { timeout: number }) {
    super();
    this.#timeout = options.timeout;
    {
      const mutPage: Mutable<AstralPage> = page;
      // @ts-ignore We wrap Page in a Mutable
      // so we can override the readonly `timeout`
      // property. Type checker doesn't like this.
      mutPage.timeout = this.#timeout;
    }
    this.#page = page;
  }

  // @ts-ignore Astral tightens the args for `EventTarget`
  override addEventListener<K extends keyof PageEventMap>(
    type: K,
    callback: (
      event: PageEventMap[K],
    ) => void,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.#checkIsOk();
    return this.#page!.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.#checkIsOk();
    return this.#page!.removeEventListener(type, callback, options);
  }

  override dispatchEvent(event: Event): boolean {
    this.#checkIsOk();
    return this.#page!.dispatchEvent(event);
  }

  /**
   * Rewrites the contents' `console.*` methods to stringify objects. The
   * Astral console handler only provides a concatenated string of all console
   * arguments, with objects represented as `"undefined"`. Calling this method
   * after navigating to a fresh document will properly stringify objects in
   * `ConsoleEvent#detail.text`.
   *
   * It also retains a bounded in-page tail of every formatted console message
   * on `globalThis.__cfConsoleTail` (`{ t, method, text }` entries, oldest
   * dropped). A failure probe evaluated in the page can include that tail, so
   * a timeout error reports what the page logged around the stall without the
   * test having to pipe the whole console stream.
   */
  async applyConsoleFormatter() {
    this.#checkIsOk();

    const trueConsoleKey: string = "__common_integration_console";
    const methods: string[] = Object.values(ConsoleMethod);

    await this.evaluate((trueConsoleKey: string, methods: string[]) => {
      // @ts-ignore: this code is stringified and sent to browser context
      // If console has already been stubbed for this document, abort.
      if (globalThis[trueConsoleKey]) {
        return;
      }
      const tail: Array<{ t: number; method: string; text: string }> =
        ((globalThis as unknown as {
          __cfConsoleTail?: Array<{ t: number; method: string; text: string }>;
        }).__cfConsoleTail ??= []);
      const TAIL_LIMIT = 300;
      const trueConsole = globalThis.console;
      const newConsole = Object.create(null);
      for (const method of methods) {
        newConsole[method] = (...args: unknown[]) => {
          const formatted = args.map((value) => {
            if (value instanceof Error) {
              // Error properties are non-enumerable — JSON.stringify yields
              // "{}". The stack includes name + message.
              return value.stack ?? `${value.name}: ${value.message}`;
            }
            if (value && typeof value === "object") {
              try {
                return JSON.stringify(value);
              } catch (_e) {
                // satisfy typescript's empty block
              }
            }
            return value;
          });
          try {
            tail.push({
              t: Date.now(),
              method,
              text: formatted.map(String).join(" ").slice(0, 400),
            });
            if (tail.length > TAIL_LIMIT) {
              tail.splice(0, tail.length - TAIL_LIMIT);
            }
          } catch (_e) {
            // Retention must never break the logging call itself.
          }
          // @ts-ignore: this code is stringified and sent to browser context
          return trueConsole[method].apply(trueConsole, formatted);
        };
      }
      // @ts-ignore: this code is stringified and sent to browser context
      globalThis[trueConsoleKey] = trueConsole;
      // @ts-ignore: this code is stringified and sent to browser context
      globalThis.console = newConsole;
    }, { args: [trueConsoleKey, methods] });
  }

  /** Takes a screenshot, storing the result at `filename`. */
  async screenshot(
    filename: string,
    options?: ScreenshotOptions,
  ): Promise<void> {
    this.#checkIsOk();
    const screenshot = await this.#page!.screenshot(options);
    return Deno.writeFile(filename, screenshot);
  }

  /**
   * Takes a screenshot and HTML capture, storing the timestamped artifacts in
   * the provided `snapshotDir`.
   */
  async snapshot(snapshotName: string, snapshotDir: string): Promise<void> {
    this.#checkIsOk();
    ensureDirSync(snapshotDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePrefix = `${snapshotName}_${timestamp}`;

    const screenshot = await this.#page!.screenshot();
    const html = await this.#page!.content();
    await Deno.writeFile(
      path.join(snapshotDir, `${filePrefix}.png`),
      screenshot,
    );
    await Deno.writeTextFile(
      path.join(snapshotDir, `${filePrefix}.html`),
      html,
    );

    console.log(`→ Snapshot saved: ${filePrefix}`);
  }

  /**
   * Waits for `selector` to contain matching `text`. Times out after the
   * page's `timeout` settings.
   */
  async waitForSelectorWithText(
    selector: string,
    text: string,
  ): Promise<ElementHandle> {
    this.#checkIsOk();
    const start = globalThis.performance.now();
    while (true) {
      const el = await this.waitForSelector(selector);
      if ((await el.innerText()) === text) {
        return el;
      }
      await sleep(200);
      if ((start + this.#timeout) < globalThis.performance.now()) {
        throw new Error(
          `Timed out waiting for "${selector}" to have text "${text}".`,
        );
      }
    }
  }

  /**
   * The Astral page this wraps. Everything this class does goes through it, so
   * a caller that replaces something on it changes what this page does.
   */
  get astralPage(): AstralPage {
    this.#checkIsOk();
    return this.#page!;
  }

  /**
   * Astral's keyboard, with `type()` patched to apply the configured default
   * delay when a call omits one.
   */
  get keyboard(): Keyboard {
    this.#checkIsOk();
    const keyboard = this.#page!.keyboard;
    if (this.#patchedKeyboard !== keyboard) {
      this.#patchedKeyboard = keyboard;
      this.#originalKeyboardType = keyboard.type.bind(keyboard);
      Object.defineProperty(keyboard, "type", {
        configurable: true,
        writable: true,
        value: (
          text: Parameters<Keyboard["type"]>[0],
          options: KeyboardTypeOptions = {},
        ) =>
          this.#originalKeyboardType!(text, {
            ...options,
            delay: options.delay ?? this.#defaultTypeDelay,
          }),
      });
    }
    return keyboard;
  }

  setInteractionObserver(observer?: InteractionObserver): void {
    this.#checkIsOk();
    this.#interactionObserver = observer;
  }

  setDefaultTypeDelay(delay: number): void {
    this.#checkIsOk();
    this.#defaultTypeDelay = delay;
  }

  /**
   * Registers `hook` to run before this page's current document goes away: a
   * navigation, a reload, or the page closing. Hooks run in the order they were
   * added, and the returned function removes this one. Anything held in the
   * document's realm — the runtime worker and what it has accumulated — is
   * still reachable from a hook and gone once it returns.
   */
  addBeforeUnloadHook(hook: () => Promise<void> | void): () => void {
    this.#beforeUnload.push(hook);
    return () => {
      const index = this.#beforeUnload.indexOf(hook);
      if (index >= 0) this.#beforeUnload.splice(index, 1);
    };
  }

  async #runBeforeUnloadHooks(): Promise<void> {
    // Over a snapshot, so a hook registered by a hook waits for the next
    // unload. Each is re-checked against the live list, so a hook whose remover
    // ran while an earlier hook was awaiting does not run afterwards.
    for (const hook of [...this.#beforeUnload]) {
      if (!this.#beforeUnload.includes(hook)) continue;
      await hook();
    }
  }

  /**
   * Registers `hook` to run after every navigation this page performs, once the
   * navigation itself has settled. Hooks run in the order they were added, and
   * the returned function removes this one. A page carries several at a time:
   * the shell driver waits here for the shell to finish booting, and a
   * presentation run starts its recorder here.
   */
  addAfterNavigationHook(hook: () => Promise<void> | void): () => void {
    this.#afterNavigation.push(hook);
    return () => {
      const index = this.#afterNavigation.indexOf(hook);
      if (index >= 0) this.#afterNavigation.splice(index, 1);
    };
  }

  async #runAfterNavigationHooks(): Promise<void> {
    // Over a snapshot, so a hook registered by a hook waits for the next
    // navigation. Each is re-checked against the live list, so a hook whose
    // remover ran while an earlier hook was awaiting does not run afterwards.
    for (const hook of [...this.#afterNavigation]) {
      if (!this.#afterNavigation.includes(hook)) continue;
      await hook();
    }
  }

  async setViewportSize(
    size: { width: number; height: number },
  ): Promise<void> {
    this.#checkIsOk();
    await this.#page!.setViewportSize(size);
  }

  async startScreencast(options: {
    format?: "jpeg" | "png";
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    everyNthFrame?: number;
  } = {}): Promise<void> {
    this.#checkIsOk();
    await this.#page!.unsafelyGetCelestialBindings().Page.startScreencast(
      options,
    );
  }

  async stopScreencast(): Promise<void> {
    this.#checkIsOk();
    await this.#page!.unsafelyGetCelestialBindings().Page.stopScreencast();
  }

  async acknowledgeScreencastFrame(sessionId: number): Promise<void> {
    this.#checkIsOk();
    await this.#page!.unsafelyGetCelestialBindings().Page.screencastFrameAck({
      sessionId,
    });
  }

  onScreencastFrame(
    listener: (frame: ScreencastFrame) => void,
  ): () => void {
    this.#checkIsOk();
    const celestial = this.#page!.unsafelyGetCelestialBindings();
    const handler: EventListener = (event) => {
      listener((event as CustomEvent<ScreencastFrame>).detail);
    };
    celestial.addEventListener("Page.screencastFrame", handler);
    return () => celestial.removeEventListener("Page.screencastFrame", handler);
  }

  /** Passes through to `@astral/astral`'s `Page#evaluate`. */
  async evaluate<T, R extends readonly unknown[]>(
    evaluate: EvaluateFunction<T, R>,
    evaluateOptions?: EvaluateOptions<R>,
  ): Promise<T> {
    this.#checkIsOk();
    return await this.#page!.evaluate(evaluate, evaluateOptions);
  }

  /**
   * Navigates through the browser protocol and waits for the requested
   * lifecycle event.
   */
  async goto(url: string, options?: NavigationOptions): Promise<void> {
    this.#checkIsOk();
    await this.#runNavigation(() => this.#navigate(url, options));
  }

  async #runNavigation(operation: () => Promise<void>): Promise<void> {
    const previousNavigation = this.#navigationQueue;
    let releaseNavigation!: () => void;
    this.#navigationQueue = new Promise((resolve) => {
      releaseNavigation = resolve;
    });
    await previousNavigation;
    try {
      await this.#runBeforeUnloadHooks();
      await operation();
    } finally {
      releaseNavigation();
    }
  }

  async #navigate(
    url: string,
    options?: NavigationOptions,
  ): Promise<void> {
    const waitUntil = options?.waitUntil;
    const navigateOptions = options?.referrer === undefined
      ? { url }
      : { url, referrer: options.referrer };

    const celestial = this.#page!.unsafelyGetCelestialBindings();
    if (waitUntil === "none") {
      const result = await celestial.Page.navigate(navigateOptions);
      if (result.errorText) throw new Error(result.errorText);
      await this.#runAfterNavigationHooks();
      return;
    }
    const lifecycleNames = waitUntil === "load"
      ? new Set(["load"])
      : new Set(["DOMContentLoaded", "networkAlmostIdle"]);
    type NavigationSignal =
      | { type: "lifecycle"; loaderId: string; name: string }
      | { type: "frame-detached"; frameId: string }
      | { type: "frame-stopped"; frameId: string }
      | {
        type: "frame-navigated";
        frameId: string;
        loaderId: string;
      }
      | { type: "inspector-detached"; reason: string };
    const navigationSignals: NavigationSignal[] = [];
    let terminalError: Error | undefined;
    let inspectorDetached = false;
    let loaderEstablished = false;
    let lifecycleAccepted = false;
    let resolveLifecycle!: () => void;
    const lifecycleReady = new Promise<void>((resolve) => {
      resolveLifecycle = resolve;
    });
    let loaderId: string | undefined;
    let frameId: string | undefined;
    const handleNavigationSignal = (signal: NavigationSignal) => {
      switch (signal.type) {
        case "lifecycle":
          if (signal.loaderId === loaderId) {
            loaderEstablished = true;
            if (
              terminalError === undefined && lifecycleNames.has(signal.name)
            ) {
              lifecycleAccepted = true;
              resolveLifecycle();
            }
          }
          break;
        case "frame-detached":
          if (signal.frameId === frameId) {
            terminalError = new Error("Navigation frame was detached.");
            resolveLifecycle();
          }
          break;
        case "frame-stopped":
          if (
            signal.frameId === frameId && loaderEstablished &&
            !lifecycleAccepted
          ) {
            terminalError = new Error(
              "Navigation frame stopped loading before it became ready.",
            );
            resolveLifecycle();
          }
          break;
        case "frame-navigated":
          if (signal.frameId !== frameId) break;
          if (signal.loaderId === loaderId) {
            loaderEstablished = true;
          } else if (loaderEstablished && !lifecycleAccepted) {
            terminalError = new Error(
              "Navigation was superseded by another document.",
            );
            resolveLifecycle();
          }
          break;
        case "inspector-detached":
          inspectorDetached = true;
          terminalError = new Error(
            `Browser session detached during navigation: ${signal.reason}`,
          );
          resolveLifecycle();
          break;
      }
    };
    const recordNavigationSignal = (signal: NavigationSignal) => {
      navigationSignals.push(signal);
      handleNavigationSignal(signal);
    };
    const lifecycleListener = (event: Event) => {
      const detail = (event as CustomEvent<{
        loaderId: string;
        name: string;
      }>).detail;
      recordNavigationSignal({ type: "lifecycle", ...detail });
    };
    const frameDetachedListener = (event: Event) => {
      const detail = (event as CustomEvent<{ frameId: string }>).detail;
      recordNavigationSignal({ type: "frame-detached", ...detail });
    };
    const frameStoppedListener = (event: Event) => {
      const detail = (event as CustomEvent<{ frameId: string }>).detail;
      recordNavigationSignal({ type: "frame-stopped", ...detail });
    };
    const frameNavigatedListener = (event: Event) => {
      const detail = (event as CustomEvent<{
        frame: { id: string; loaderId: string };
      }>).detail;
      recordNavigationSignal({
        type: "frame-navigated",
        frameId: detail.frame.id,
        loaderId: detail.frame.loaderId,
      });
    };
    const inspectorDetachedListener = (event: Event) => {
      const detail = (event as CustomEvent<{ reason: string }>).detail;
      recordNavigationSignal({ type: "inspector-detached", ...detail });
    };

    await celestial.Page.setLifecycleEventsEnabled({ enabled: true });
    celestial.addEventListener("Page.lifecycleEvent", lifecycleListener);
    celestial.addEventListener("Page.frameDetached", frameDetachedListener);
    celestial.addEventListener(
      "Page.frameStoppedLoading",
      frameStoppedListener,
    );
    celestial.addEventListener("Page.frameNavigated", frameNavigatedListener);
    celestial.addEventListener("Inspector.detached", inspectorDetachedListener);
    let navigationFailed = false;
    let navigationError: unknown;
    try {
      const result = await celestial.Page.navigate(navigateOptions);
      if (result.errorText) throw new Error(result.errorText);
      loaderId = result.loaderId;
      frameId = result.frameId;
      for (const signal of navigationSignals) handleNavigationSignal(signal);
      if (terminalError) throw terminalError;
      if (loaderId !== undefined) {
        await lifecycleReady;
        if (terminalError) throw terminalError;
      }
    } catch (error) {
      navigationFailed = true;
      navigationError = error;
    } finally {
      celestial.removeEventListener("Page.lifecycleEvent", lifecycleListener);
      celestial.removeEventListener(
        "Page.frameDetached",
        frameDetachedListener,
      );
      celestial.removeEventListener(
        "Page.frameStoppedLoading",
        frameStoppedListener,
      );
      celestial.removeEventListener(
        "Page.frameNavigated",
        frameNavigatedListener,
      );
      celestial.removeEventListener(
        "Inspector.detached",
        inspectorDetachedListener,
      );
    }
    let cleanupFailed = false;
    let cleanupError: unknown;
    if (!inspectorDetached) {
      try {
        await celestial.Page.setLifecycleEventsEnabled({ enabled: false });
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
    if (navigationFailed) throw navigationError;
    if (cleanupFailed) throw cleanupError;
    await this.#runAfterNavigationHooks();
  }

  /** Passes through to `@astral/astral`'s `Page#reload`. */
  async reload(options?: WaitForOptions): Promise<void> {
    this.#checkIsOk();
    await this.#runNavigation(async () => {
      await this.#page!.reload(options);
      await this.#runAfterNavigationHooks();
    });
  }

  /**
   * Passes through to `@astral/astral`'s `Page#waitForSelector`.
   *
   * With `strategy: "pierce"` the wait is driven by page events and takes no
   * timeout, and it resolves against the same elements `$` with that strategy
   * returns: light-DOM elements and elements inside open shadow roots alike.
   */
  async waitForSelector(
    selector: string,
    options?: WaitForSelectorOptions & SelectorOptions,
  ): Promise<ElementHandle> {
    this.#checkIsOk();
    if (options?.strategy === "pierce") {
      if (options.timeout !== undefined) {
        throw new TypeError(
          "Pierce-selector waits are event-driven and do not accept a timeout",
        );
      }
      return this.#decorateElement(
        await waitForPierceSelector(this.#page!, selector),
      );
    }
    const astralOptions = options?.timeout === undefined
      ? undefined
      : { timeout: options.timeout };
    return this.#decorateElement(
      await this.#page!.waitForSelector(selector, astralOptions),
    );
  }

  /** Passes through to `@astral/astral`'s `Page#waitForFunction`. */
  async waitForFunction<T, R extends readonly unknown[]>(
    func: EvaluateFunction<T, R>,
    evaluateOptions?: EvaluateOptions<R>,
  ): Promise<void> {
    this.#checkIsOk();
    await this.#page!.waitForFunction(func, evaluateOptions);
  }

  /**
   * Exposes a CDP binding named `name` on the page's global object. Calling
   * `globalThis[name](payload)` in the page produces a `Runtime.bindingCalled`
   * notification that `onBindingCalled()` delivers to the test process. This is
   * how an in-page notifier signals the moment a condition holds without the
   * test polling the DOM.
   */
  async addBinding(name: string): Promise<void> {
    this.#checkIsOk();
    await this.#page!.unsafelyGetCelestialBindings().Runtime.addBinding({
      name,
    });
  }

  /**
   * Unsubscribes the current connection from a binding's notifications. The
   * bound function may remain on the page's global object; the unique per-wait
   * name keeps that harmless.
   */
  async removeBinding(name: string): Promise<void> {
    this.#checkIsOk();
    await this.#page!.unsafelyGetCelestialBindings().Runtime.removeBinding({
      name,
    });
  }

  /**
   * Subscribes to every `Runtime.bindingCalled` notification, invoking
   * `listener` with the binding name and its payload. Returns an unsubscribe
   * function.
   */
  onBindingCalled(
    listener: (name: string, payload: string) => void,
  ): () => void {
    this.#checkIsOk();
    const celestial = this.#page!.unsafelyGetCelestialBindings();
    const handler: EventListener = (event) => {
      const { name, payload } =
        (event as CustomEvent<{ name: string; payload: string }>).detail;
      listener(name, payload);
    };
    celestial.addEventListener("Runtime.bindingCalled", handler);
    return () =>
      celestial.removeEventListener("Runtime.bindingCalled", handler);
  }

  /** Passes through to `@astral/astral`'s `Page#$`. */
  async $(
    selector: string,
    opts?: SelectorOptions,
  ): Promise<ElementHandle | null> {
    this.#checkIsOk();
    const element = opts?.strategy === "pierce"
      ? await queryPierce(this.#page!, selector)
      : await this.#page!.$(selector);
    return this.#decorateElement(element);
  }

  /** Passes through to `@astral/astral`'s `Page#$$`. */
  async $$(selector: string, opts?: SelectorOptions): Promise<ElementHandle[]> {
    this.#checkIsOk();
    const elements = opts?.strategy === "pierce"
      ? await queryAllPierce(this.#page!, selector)
      : await this.#page!.$$(selector);
    return elements.map((element) => this.#decorateElement(element));
  }

  /**
   * Dispatches one trusted click at a viewport point.
   *
   * For a caller that has already worked out where to click — a wait that
   * measured its target at the instant the target was ready, say — this is the
   * dispatch on its own. A caller whose target can move may provide a function
   * that refreshes the point after the interaction observer has finished. The
   * interaction observer sees this dispatch as it sees an element's, with no
   * element to name, so a presentation recording still moves and pulses its
   * cursor over a click aimed by coordinates.
   */
  async clickPoint(
    point: { x: number; y: number },
    options?: { refreshPoint?: () => Promise<{ x: number; y: number }> },
  ): Promise<void> {
    this.#checkIsOk();
    await this.#dispatchObservedClick(
      undefined,
      point,
      undefined,
      options?.refreshPoint,
    );
  }

  /** Passes through to `@astral/astral`'s `Page#close`. */
  async close() {
    this.#checkIsOk();
    await this.#runBeforeUnloadHooks();
    const page = this.#page;
    this.#page = null;
    await page!.close();
  }

  #checkIsOk() {
    if (!this.#page) {
      throw new Error("Page is already closed.");
    }
  }

  #decorateElement(element: null): null;
  #decorateElement(element: AstralElementHandle): ElementHandle;
  #decorateElement(
    element: AstralElementHandle | null,
  ): ElementHandle | null;
  #decorateElement(
    element: AstralElementHandle | null,
  ): ElementHandle | null {
    if (!element) return null;
    if (this.#decoratedElements.has(element)) return element as ElementHandle;
    this.#decoratedElements.add(element);

    const nativeQuery = element.$.bind(element);
    const nativeQueryAll = element.$$.bind(element);
    const nativeWaitForSelector = element.waitForSelector.bind(element);
    Object.defineProperties(element, {
      $: {
        configurable: true,
        value: async (selector: string, options?: SelectorOptions) => {
          this.#checkIsOk();
          const child = options?.strategy === "pierce"
            ? await queryPierce(this.#page!, selector, element)
            : await nativeQuery(selector);
          return this.#decorateElement(child);
        },
      },
      $$: {
        configurable: true,
        value: async (selector: string, options?: SelectorOptions) => {
          this.#checkIsOk();
          const children = options?.strategy === "pierce"
            ? await queryAllPierce(this.#page!, selector, false, element)
            : await nativeQueryAll(selector);
          return children.map((child) => this.#decorateElement(child));
        },
      },
      click: {
        configurable: true,
        value: (
          options?: Parameters<AstralElementHandle["click"]>[0],
        ) => this.#clickElement(element, options),
      },
      type: {
        configurable: true,
        value: (text: string, options?: KeyboardTypeOptions) =>
          this.#typeIntoElement(element, text, options),
      },
      waitForSelector: {
        configurable: true,
        value: async (
          selector: string,
          options?: WaitForSelectorOptions & SelectorOptions,
        ) => {
          this.#checkIsOk();
          if (options?.strategy === "pierce") {
            if (options.timeout !== undefined) {
              throw new TypeError(
                "Pierce-selector waits are event-driven and do not accept a timeout",
              );
            }
            return this.#decorateElement(
              await waitForPierceSelector(this.#page!, selector, element),
            );
          }
          const astralOptions = options?.timeout === undefined
            ? undefined
            : { timeout: options.timeout };
          return this.#decorateElement(
            await nativeWaitForSelector(selector, astralOptions),
          );
        },
      },
    });
    return element as ElementHandle;
  }

  async #clickElement(
    element: AstralElementHandle,
    options?: Parameters<AstralElementHandle["click"]>[0],
  ): Promise<void> {
    const aim = await aimAtElement(this.#page!, element, options?.offset);
    if ("unclickable" in aim) {
      throw new Error(`Cannot click ${describeAimTarget(aim)}`);
    }
    await this.#dispatchObservedClick(
      element as ElementHandle,
      { x: aim.x, y: aim.y },
      options,
    );
  }

  /**
   * Dispatches one trusted click at `point`, with the interaction observer told
   * before and after. The point can be refreshed after the observer has
   * finished. The observer's failure is reported only when the click itself
   * succeeded, so a recording problem never masks a click problem.
   */
  async #dispatchObservedClick(
    element: ElementHandle | undefined,
    point: { x: number; y: number },
    options?: Parameters<AstralElementHandle["click"]>[0],
    refreshPoint?: () => Promise<{ x: number; y: number }>,
  ): Promise<void> {
    await this.#interactionObserver?.beforeClick?.(element, point);
    let dispatchPoint = point;
    let actionError: unknown;
    try {
      dispatchPoint = await refreshPoint?.() ?? point;
      await this.#page!.mouse.click(
        dispatchPoint.x,
        dispatchPoint.y,
        options,
      );
    } catch (error) {
      actionError = error;
    }
    try {
      await this.#interactionObserver?.afterClick?.(
        element,
        dispatchPoint,
        actionError,
      );
    } catch (observerError) {
      if (actionError === undefined) throw observerError;
    }
    if (actionError !== undefined) throw actionError;
  }

  async #typeIntoElement(
    element: AstralElementHandle,
    text: string,
    options?: KeyboardTypeOptions,
  ): Promise<void> {
    await element.focus();
    await this.#interactionObserver?.beforeType?.(
      element as ElementHandle,
      text,
    );
    let actionError: unknown;
    try {
      await this.keyboard.type(text, options);
    } catch (error) {
      actionError = error;
    }
    try {
      await this.#interactionObserver?.afterType?.(
        element as ElementHandle,
        text,
        actionError,
      );
    } catch (observerError) {
      if (actionError === undefined) throw observerError;
    }
    if (actionError !== undefined) throw actionError;
  }
}

/**
 * Where a trusted click should land, or why it cannot land at all.
 *
 * The point is in viewport coordinates, which is what `Input.dispatchMouseEvent`
 * takes, and is measured after the element has been scrolled into view.
 */
export type AimResult =
  | { x: number; y: number }
  | {
    unclickable: "detached" | "not-rendered" | "off-page" | "unresolvable";
    tag?: string;
    id?: string;
    rootHost?: string;
    display?: string;
    visibility?: string;
    width?: number;
    height?: number;
    detail?: string;
  };

type RetainedAim = {
  retained: true;
  tag: string;
  id: string;
  rootHost?: string;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  rect: { x: number; y: number; width: number; height: number };
};

/**
 * Scroll `element` into view and measure the point to click.
 *
 * A center aim scrolls and measures in one page turn. An offset aim scrolls and
 * retains the exact element in that turn, then asks CDP for its composed content
 * quad. The remote-object reference survives DOM-agent node-id invalidation and
 * CDP accounts for ancestor transforms, 3D projection, and SVG layout.
 *
 * The point is the middle of the part of the element's box that lies inside the
 * page, which for an element the page has room for is the middle of the whole
 * box. An element reaching past the edge of the page can have its middle
 * outside the page, and the browser accepts a trusted click dispatched there,
 * delivers it to nothing, and reports no error for having done so. What the
 * page shows of an element is a wider question than this: an ancestor's
 * overflow can clip it, and anything painted over it can cover it. Neither
 * moves this point.
 *
 * An element with no layout box, and one with no part of it inside the page,
 * yield `unclickable` naming what is wrong with it, rather than an empty
 * measurement the caller has to guess at.
 */
let aimElementSequence = 0;

async function aimAtElement(
  page: AstralPage,
  element: AstralElementHandle,
  offset?: { x: number; y: number },
): Promise<AimResult> {
  const retainedKey = offset
    ? `__common_tools_aim_element_${++aimElementSequence}`
    : null;
  try {
    const prepared = await element.evaluate(
      (
        el: Element,
        retainedKey: string | null,
      ): AimResult | RetainedAim => {
        const describe = () => ({
          tag: el.tagName.toLowerCase(),
          id: el.id,
          rootHost: (el.getRootNode() as ShadowRoot).host?.tagName
            ?.toLowerCase(),
        });
        if (!el.isConnected) {
          return { unclickable: "detached", ...describe() };
        }
        // Instant, because a page-level `scroll-behavior: smooth` would leave
        // the element still moving when the rect below is read.
        el.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "instant",
        });
        const style = globalThis.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (
          style.display === "none" || style.visibility === "hidden" ||
          rect.width === 0 || rect.height === 0
        ) {
          return {
            unclickable: "not-rendered",
            ...describe(),
            display: style.display,
            visibility: style.visibility,
            width: rect.width,
            height: rect.height,
          };
        }
        // The area a click can land in, in the same coordinates the rect is
        // reported in. The root element's client box rather than the window,
        // because a classic scrollbar takes columns the window counts and a
        // click cannot reach.
        const pageWidth = document.documentElement.clientWidth;
        const pageHeight = document.documentElement.clientHeight;
        const left = Math.max(rect.x, 0);
        const right = Math.min(rect.x + rect.width, pageWidth);
        const top = Math.max(rect.y, 0);
        const bottom = Math.min(rect.y + rect.height, pageHeight);
        if (right <= left || bottom <= top) {
          return {
            unclickable: "off-page",
            ...describe(),
            width: rect.width,
            height: rect.height,
            detail: `box ${JSON.stringify(rect)}, ` +
              `page ${
                JSON.stringify({ width: pageWidth, height: pageHeight })
              }`,
          };
        }
        if (retainedKey !== null) {
          Object.defineProperty(globalThis, retainedKey, {
            configurable: true,
            value: el,
          });
          return {
            retained: true,
            ...describe(),
            width: rect.width,
            height: rect.height,
            pageWidth,
            pageHeight,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          };
        }

        return { x: (left + right) / 2, y: (top + bottom) / 2 };
      },
      { args: [retainedKey] },
    );
    if (!("retained" in prepared)) return prepared;

    const contentQuad = await measureRetainedContentQuad(page, retainedKey!);
    let contentOrigin = contentQuad[0];
    for (const point of contentQuad) {
      // This deliberately mirrors published Astral's definition of top-left.
      if (point.x < contentOrigin.x && point.y < contentOrigin.y) {
        contentOrigin = point;
      }
    }
    const point = {
      x: contentOrigin.x + offset!.x,
      y: contentOrigin.y + offset!.y,
    };
    if (
      point.x < 0 || point.x >= prepared.pageWidth ||
      point.y < 0 || point.y >= prepared.pageHeight
    ) {
      return {
        unclickable: "off-page",
        tag: prepared.tag,
        id: prepared.id,
        rootHost: prepared.rootHost,
        width: prepared.width,
        height: prepared.height,
        detail: `box ${JSON.stringify(prepared.rect)}, ` +
          `point ${JSON.stringify(point)}, ` +
          `page ${
            JSON.stringify({
              width: prepared.pageWidth,
              height: prepared.pageHeight,
            })
          }`,
      };
    }
    return point;
  } catch (error) {
    // A handle whose node the DOM agent no longer knows about cannot be
    // resolved to a page object at all. That happens to every outstanding
    // handle the moment anything else queries the document, so it is a
    // separate condition from an element that is present but unclickable.
    return { unclickable: "unresolvable", detail: String(error) };
  }
}

/** The human-readable half of an {@link AimResult} that cannot be clicked. */
function describeAimTarget(aim: Extract<AimResult, { unclickable: string }>) {
  const named = aim.id ? `${aim.tag}#${aim.id}` : aim.tag ?? "the element";
  const inside = aim.rootHost ? ` inside <${aim.rootHost}>` : "";
  switch (aim.unclickable) {
    case "detached":
      return `${named}${inside}: it is no longer in the document`;
    case "not-rendered":
      return `${named}${inside}: it has no layout box ` +
        `(display: ${aim.display}, visibility: ${aim.visibility}, ` +
        `${aim.width}x${aim.height})`;
    case "off-page":
      return `${named}${inside}: the point to click lies outside the page, ` +
        `so a click there would reach nothing (${aim.detail})`;
    default:
      return `the element: its handle no longer resolves to a node ` +
        `(${aim.detail})`;
  }
}
