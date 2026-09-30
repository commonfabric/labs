import { sleep } from "@commonfabric/utils/sleep";
import { describeThrown } from "./describe-thrown.ts";
import type { Page } from "./page.ts";
import { readAndDescribeShellPage } from "./shell-page-probe.ts";

// Default poll interval between predicate calls. Polls are cheap (a CDP
// evaluate round-trip), and a coarse interval quantizes every wall-clock
// measurement taken around a waitFor up to its multiple — the old 500ms
// default made the default-app timing series report ~520ms for phases whose
// real latency was far lower. Override per run with CF_WAITFOR_DELAY_MS.
const DEFAULT_DELAY_MS = (() => {
  try {
    const raw = Number(Deno.env.get("CF_WAITFOR_DELAY_MS"));
    return Number.isFinite(raw) && raw > 0 ? raw : 50;
  } catch {
    return 50;
  }
})();

// Built-in safety net for a genuinely stuck condition in waitForCondition. The
// wait is notification-driven and resolves the instant its predicate holds, so
// this bound is never the common-case latency; it is generous enough to cover
// the slowest legitimate wait (a runtime resync after a reload) without capping
// a condition that is still making progress.
const WAIT_FOR_CONDITION_TIMEOUT = 300_000; // 5 minutes

/**
 * The safety net's length for one wait. Read per wait rather than once, and
 * from `CF_WAIT_FOR_CONDITION_TIMEOUT_MS`, which is how a test drives the
 * report this net produces without waiting five minutes for it. Nothing
 * outside a test sets it: shortening the net in a run caps what a wait can
 * observe, which is the thing the net is written to avoid.
 */
function waitForConditionTimeout(): number {
  try {
    const raw = Number(Deno.env.get("CF_WAIT_FOR_CONDITION_TIMEOUT_MS"));
    return Number.isFinite(raw) && raw > 0 ? raw : WAIT_FOR_CONDITION_TIMEOUT;
  } catch {
    return WAIT_FOR_CONDITION_TIMEOUT;
  }
}

// How much of any one value a failure report carries on its line. Long enough
// to tell one wait in a file from the next, short enough that a line stays
// readable beside the page it is reported with.
const CONDITION_VALUE_LIMIT = 400;

/** `value` on one line, cut to {@link CONDITION_VALUE_LIMIT}. */
function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > CONDITION_VALUE_LIMIT
    ? `${collapsed.slice(0, CONDITION_VALUE_LIMIT)}…`
    : collapsed;
}

/**
 * Render what a wait was waiting for and what `page` held while it waited.
 *
 * `predicateSource` is the source the page ran, and it is usually what names
 * the wait, waits carrying no names of their own. Where several waits share
 * one predicate the arguments are what tell them apart, so each gets a line of
 * its own rather than being run together.
 *
 * `predicateError` is the message of the last throw the predicate itself made,
 * where it made one. A predicate that throws on every evaluation is stuck for
 * a reason nothing else in the report carries, since the page is exactly as it
 * would be for a predicate that is merely false.
 */
export async function describeConditionWaitFailure(
  page: Page,
  predicateSource: string,
  args?: readonly unknown[],
  predicateError?: string,
): Promise<string> {
  const lines = [`  awaited condition: ${oneLine(predicateSource)}`];
  if (args !== undefined && args.length > 0) {
    lines.push("  condition arguments:");
    args.forEach((arg, index) => {
      // A value JSON cannot carry is reported as one: a report must not
      // replace the failure it describes with a failure of its own. The
      // numbers JSON renders as something else are spelled out instead,
      // since a wait told apart from its neighbours by an argument is told
      // apart wrongly when that argument reads back as `null` or `0`.
      let rendered: string;
      try {
        rendered = JSON.stringify(arg, (_key, value) =>
          typeof value === "number" &&
            (!Number.isFinite(value) || Object.is(value, -0))
            ? (Object.is(value, -0) ? "-0" : String(value))
            : value) ?? String(arg);
      } catch (error) {
        rendered = `(unrenderable: ${describeThrown(error)})`;
      }
      lines.push(`    [${index}] ${oneLine(rendered)}`);
    });
  }
  if (predicateError !== undefined) {
    lines.push(`  predicate threw: ${oneLine(predicateError)}`);
  }
  lines.push(await readAndDescribeShellPage(page));
  return lines.join("\n");
}

/**
 * Receives an async predicate function to executed repeatedly
 * until either the predicate returns `true`, or throws once
 * the timeout limit has been reached.
 *
 * @param predicate - The predicate callback.
 * @param config.timeout - The number of milliseconds to wait before throwing. [60000]
 * @param config.delay - The number of milliseconds to wait between predicate
 *   calls. [50, or CF_WAITFOR_DELAY_MS]
 */
export const waitFor = async (
  predicate: () => Promise<boolean>,
  { timeout: _timeout, delay: _delay }: { timeout?: number; delay?: number } =
    {},
): Promise<void> => {
  const timeout = _timeout ?? 60_000;
  const delay = _delay ?? DEFAULT_DELAY_MS;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await predicate())) {
      return;
    }
    await sleep(delay);
  }
  throw new Error(
    `Timeout: waitFor predicate could not complete after ${timeout}ms.`,
  );
};

/**
 * Wait until the shell's rendered UI has caught up to runtime state and is
 * interactive. The reactive scheduler runs in a worker while the DOM lives on
 * the main thread, so there are three stages between a state change and a
 * clickable control: the worker settles reactively, the resulting vdom batch
 * crosses to the main thread and is applied, and the Lit elements finish their
 * update cycle (which is when cf-modal binds handlers and drops
 * `pointer-events:none`). This resolves once all three have happened.
 *
 * Returns true once settled, or false when the shell has not yet exposed
 * `commonfabric.viewSettled` (for example the runtime is still starting), so a
 * caller can keep polling with `waitFor`.
 *
 * Call this before issuing a click or keystroke after navigation or any state
 * change, so the stimulus lands on a bound handler instead of a freshly
 * rendered element whose handler is not wired up yet.
 */
export const awaitViewSettled = async (page: Page): Promise<boolean> => {
  return await page.evaluate(async () => {
    const settled = (globalThis as {
      commonfabric?: { viewSettled?: () => Promise<void> };
    }).commonfabric?.viewSettled;
    if (!settled) return false;
    await settled();
    return true;
  });
};

/**
 * Shadow-piercing DOM helpers handed to a {@link waitForCondition} predicate.
 * They run in the page, where the app is a tree of web components with nested
 * shadow roots, so a predicate can find elements and read their visible text
 * without re-implementing the traversal each time.
 */
export interface ProbeApi {
  /** Every element matching `selector`, descending through shadow roots. */
  collect(selector: string): Element[];

  /**
   * Whether `element` is rendered: it has a non-empty layout box and is not
   * `display:none` or `visibility:hidden`. Viewport-independent, so an element
   * below the fold is rendered. This is the "is this control laid out yet"
   * question a predicate asks before tagging a control it is about to click —
   * a click scrolls the element into view itself.
   */
  isRendered(element: Element): boolean;

  /**
   * Whether `element` declines a click: it carries `disabled`, or
   * `aria-disabled="true"`. This is the "will this control act on a click"
   * question a predicate asks alongside {@link ProbeApi.isRendered}, because a
   * control can be laid out and take no click. A component that wraps its
   * control in a host asks this of both: `disabled` does not inherit, so a host
   * carrying it over a control that does not is a separate answer.
   */
  isDisabled(element: Element): boolean;

  /** Whether `element` is rendered and also on-screen. */
  isVisible(element: Element): boolean;

  /** Visible text of `root` plus its shadow and slotted descendants. */
  deepText(root: ParentNode): string;

  /**
   * Add `token` to the whitespace-separated token list held in `element`'s
   * `attribute`, keeping the tokens already there. This is how a predicate
   * tags an element it has resolved without disturbing a tag another wait
   * placed on the same element. Adding a token twice leaves one copy.
   */
  addToken(element: Element, attribute: string, token: string): void;
}

/**
 * A predicate evaluated in the page. It receives a {@link ProbeApi} plus the
 * `args` passed to {@link waitForCondition}, and returns whether the awaited
 * condition holds. It may be async (for example to await `rt.idle()`).
 *
 * A predicate may answer with a JSON value instead of `true`. Any truthy result
 * satisfies the condition, and a result other than `true` is carried back to
 * the test process as {@link waitForCondition}'s resolution. That is how a
 * wait hands over a measurement taken at the instant the condition held —
 * the coordinates a trusted click is about to be aimed at, say — without a
 * second round trip in which the page could move on. Values outside
 * {@link PageConditionValue} are rejected rather than being silently changed
 * by JSON serialization at the page boundary.
 */
export type PageConditionValue =
  | null
  | boolean
  | number
  | string
  | readonly PageConditionValue[]
  | { readonly [key: string]: PageConditionValue };

export type PageCondition<
  A extends readonly unknown[],
  R extends PageConditionValue = PageConditionValue,
> = (
  probe: ProbeApi,
  ...args: A
) => boolean | R | Promise<boolean | R>;

/**
 * Installed in the page by {@link waitForCondition}. Re-evaluates `predicate`
 * whenever the UI could have changed — a shared pulse hub observes the document
 * and every shadow root (subtree, character data, and attributes), including
 * shadow roots created after the wait began, so the predicate runs the instant
 * the DOM reflects new state instead of on a fixed timer. When the predicate
 * holds, it calls the CDP binding `bindingName`, which wakes the awaiting test
 * process. An async predicate that awaits a runtime signal (such as
 * `rt.idle()`) resolves the moment that signal fires, with no DOM change
 * required.
 *
 * Self-contained: it is serialized and run in the page, so it closes over none
 * of the module scope. `predicateSource` is the predicate's source text,
 * reconstructed here because a function cannot cross the evaluate boundary as a
 * callable value.
 */
function installWaiter(
  bindingName: string,
  predicateSource: string,
  predicateArgs: unknown[],
  events: string[],
): void {
  const isRendered = (element: Element): boolean => {
    const style = globalThis.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const isDisabled = (element: Element): boolean =>
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true";

  // Typed as the ProbeApi the predicates are handed, so a method added to that
  // interface has to be implemented here too. The annotation is erased before
  // this function is serialized into the page, so it adds no runtime reference
  // to module scope.
  const probe: ProbeApi = {
    collect(selector) {
      const out: Element[] = [];
      const walk = (root: Document | ShadowRoot) => {
        for (const el of root.querySelectorAll("*")) {
          try {
            if (el.matches(selector)) out.push(el);
          } catch {
            // An invalid selector matches nothing.
          }
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      return out;
    },
    isRendered,
    isDisabled,
    isVisible(element) {
      if (!isRendered(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= globalThis.innerHeight &&
        rect.left <= globalThis.innerWidth;
    },
    deepText(root) {
      const parts: string[] = [];
      const visited = new WeakSet<ParentNode>();
      const scanned = new WeakSet<ParentNode>();

      /** Discovers shadow roots once across overlapping light and slot paths. */
      const scan = (node: ParentNode): void => {
        if (scanned.has(node)) return;
        scanned.add(node);
        for (const child of node.children) {
          if (child.shadowRoot) visit(child.shadowRoot);
          scan(child);
        }
      };

      /** Collects visible root and slotted text once per node. */
      const visit = (node: ParentNode): void => {
        if (visited.has(node)) return;
        visited.add(node);
        if (node instanceof HTMLElement) {
          const style = globalThis.getComputedStyle(node);
          const hidden = node instanceof HTMLStyleElement ||
            node instanceof HTMLScriptElement || node.hidden ||
            style.visibility === "hidden" || style.display === "none";
          if (!hidden) {
            const innerText = node.innerText ?? "";
            parts.push(
              innerText.trim().length > 0 ? innerText : node.textContent ?? "",
            );
          }
          if (node instanceof HTMLSlotElement) {
            for (const assigned of node.assignedElements({ flatten: true })) {
              visit(assigned);
            }
          }
          if (node.shadowRoot) visit(node.shadowRoot);
        } else if (node instanceof Document || node instanceof ShadowRoot) {
          for (const child of node.children) {
            if (child instanceof HTMLElement) visit(child);
          }
        }
        scan(node);
      };
      visit(root);
      return parts.join(" ");
    },
    addToken(element, attribute, token) {
      const tokens = new Set(
        (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean),
      );
      tokens.add(token);
      element.setAttribute(attribute, [...tokens].join(" "));
    },
  };

  const predicate = new Function("return (" + predicateSource + ")")() as (
    probe: ProbeApi,
    ...args: unknown[]
  ) => unknown;

  // Shared pulse hub, installed once per document. A document-level
  // MutationObserver cannot see inside shadow roots, so the hub also observes
  // every shadow root — those present now and those created later, caught by
  // wrapping Element.prototype.attachShadow — and fans a "DOM may have changed"
  // pulse out to every active waiter. Without this, a deep text change inside a
  // shadow root created after the wait began would go unnoticed.
  const hub = ((globalThis as typeof globalThis & {
    __cfcPulseHub?: { listeners: Set<() => void> };
  }).__cfcPulseHub ??= (() => {
    const listeners = new Set<() => void>();
    const observed = new WeakSet<Document | ShadowRoot>();
    // Keep observers reachable from JS. A MutationObserver with no script
    // reference can be collected even while its node lives, which would silently
    // stop pulses; the array prevents that.
    const retained: MutationObserver[] = [];
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const observe = (root: Document | ShadowRoot) => {
      if (observed.has(root)) return;
      observed.add(root);
      const mo = new MutationObserver(notify);
      retained.push(mo);
      mo.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    };
    const scan = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          observe(el.shadowRoot);
          scan(el.shadowRoot);
        }
      }
    };
    observe(document);
    const proto = Element.prototype as Element & {
      attachShadow: (init: ShadowRootInit) => ShadowRoot;
    };
    const original = proto.attachShadow;
    proto.attachShadow = function (
      this: Element,
      init: ShadowRootInit,
    ): ShadowRoot {
      const root = original.call(this, init);
      observe(root);
      // Content may be set synchronously right after attachShadow, so pulse.
      notify();
      return root;
    };
    scan(document);
    return { listeners };
  })());

  const registry = ((globalThis as typeof globalThis & {
    __cfcWaiters?: Map<string, () => void>;
  }).__cfcWaiters ??= new Map<string, () => void>());
  // A leftover waiter under this name would only exist after a name collision;
  // dispose it so its pulse stops running.
  registry.get(bindingName)?.();

  let stopped = false;
  let signaled = false;
  let running = false;
  let rerun = false;

  // The value the predicate answered with, carried to the test process in the
  // binding payload so a measurement taken at the instant the condition held
  // reaches the caller without a second round trip.
  let answer: unknown = true;

  // Copy an answer into the exact value JSON will carry. JSON.stringify alone
  // is not a validator: it silently drops functions, symbols, and undefined
  // properties, turns Map into {}, and changes non-finite numbers to null. A
  // wait must either deliver the predicate's answer or report that it cannot;
  // silently delivering a different value makes the condition look satisfied
  // with an answer it never produced.
  const copyJsonAnswer = (
    value: unknown,
    path = "$",
    seen = new WeakSet<object>(),
  ): unknown => {
    if (
      value === null || typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        const kind = Object.is(value, -0)
          ? "Negative zero"
          : "Non-finite number";
        throw new TypeError(`${kind} at ${path} is not JSON-safe`);
      }
      return value;
    }
    if (typeof value !== "object") {
      throw new TypeError(`${typeof value} at ${path} is not JSON-safe`);
    }
    if (seen.has(value)) {
      throw new TypeError(`Cycle at ${path} is not JSON-safe`);
    }

    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
          throw new TypeError(`toJSON at ${path} is not JSON-safe`);
        }
        if (
          Object.keys(value).some((key) => {
            const index = Number(key);
            return !Number.isInteger(index) || index < 0 ||
              index >= value.length || String(index) !== key;
          }) ||
          Object.getOwnPropertySymbols(value).some((symbol) =>
            Object.prototype.propertyIsEnumerable.call(value, symbol)
          )
        ) {
          throw new TypeError(`Array properties at ${path} are not JSON-safe`);
        }

        const copy: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new TypeError(`Sparse array at ${path} is not JSON-safe`);
          }
          copy.push(copyJsonAnswer(value[index], `${path}[${index}]`, seen));
        }
        return copy;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        const tag = Object.prototype.toString.call(value);
        throw new TypeError(`${tag} at ${path} is not a plain JSON object`);
      }
      if (
        Object.getOwnPropertySymbols(value).some((symbol) =>
          Object.prototype.propertyIsEnumerable.call(value, symbol)
        )
      ) {
        throw new TypeError(
          `Enumerable symbol key at ${path} is not JSON-safe`,
        );
      }

      const copy = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value)) {
        copy[key] = copyJsonAnswer(
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
          seen,
        );
      }
      return copy;
    } finally {
      seen.delete(value);
    }
  };

  // A predicate that throws is a stuck wait whose cause the page alone knows,
  // so its message is sent over the same binding, tagged so the test process
  // records it rather than treating the wait as over. Only a message differing
  // from the last sent is sent, a predicate throwing on every evaluation being
  // the ordinary case.
  let reportedError: string | undefined;
  const reportPredicateError = (error: unknown): void => {
    const text = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    if (text === reportedError) return;
    const notify = (globalThis as Record<string, unknown>)[bindingName];
    if (typeof notify !== "function") return;
    reportedError = text;
    (notify as (payload: string) => void)(
      JSON.stringify({ predicateError: text }),
    );
  };

  const fire = (): boolean => {
    const notify = (globalThis as Record<string, unknown>)[bindingName];
    if (typeof notify !== "function") return false;
    signaled = true;
    let payload: string;
    try {
      payload = JSON.stringify({
        value: answer === true ? undefined : copyJsonAnswer(answer),
      });
    } catch (error) {
      // An answer that cannot cross the boundary is reported as one. Sending
      // "no value" instead would read to the caller as a condition that held
      // and simply had nothing to say, which is a different thing.
      payload = JSON.stringify({
        unserializable: String(
          error instanceof Error ? error.message : error,
        ),
      });
    }
    (notify as (payload: string) => void)(payload);
    return true;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopObserving();
    registry.delete(bindingName);
  };

  const stopObserving = () => {
    hub.listeners.delete(pulse);
    for (const event of events) globalThis.removeEventListener(event, pulse);
    clearInterval(backstop);
  };

  const onConditionMet = () => {
    if (stopped) return;
    stopped = true;
    stopObserving();
    // The binding is added and awaited before this script installs, so the
    // bound function is normally present; retry a bounded number of times on the
    // macrotask queue in case it has not yet attached to this execution context.
    // If it never attaches, report it rather than spinning silently until the
    // outer timeout.
    let attempts = 0;
    const tryFire = () => {
      if (signaled) return;
      if (fire()) {
        registry.delete(bindingName);
      } else if (++attempts < 100) {
        setTimeout(tryFire, 0);
      } else {
        console.error(
          `[waitForCondition] binding "${bindingName}" never became callable;` +
            ` condition held but could not signal the test.`,
        );
      }
    };
    tryFire();
  };

  const evaluate = () => {
    if (stopped || running) {
      if (running) rerun = true;
      return;
    }
    running = true;
    Promise.resolve()
      .then(() => predicate(probe, ...predicateArgs))
      .then((ok) => {
        running = false;
        if (stopped) return;
        if (ok) {
          answer = ok;
          onConditionMet();
        } else if (rerun) {
          rerun = false;
          evaluate();
        }
      })
      .catch((error) => {
        running = false;
        if (stopped) return;
        reportPredicateError(error);
        if (rerun) {
          rerun = false;
          evaluate();
        }
      });
  };

  function pulse() {
    evaluate();
  }

  registry.set(bindingName, stop);
  hub.listeners.add(pulse);
  for (const event of events) globalThis.addEventListener(event, pulse);
  // Mutation pulses are the fast path, but a condition can flip true with no
  // mutation record at all — e.g. a Lit `.value=` binding writing a committed
  // cell value back into an input sets only the element property. A coarse
  // timer backstop re-evaluates so such waits converge instead of starving
  // until the outer timeout.
  // TODO(Hixie): Subscribe to cell changes or rendering completion for conditions
  // without DOM mutations, then remove this polling backstop.
  const backstop = events.length === 0 ? setInterval(evaluate, 500) : undefined;
  // Check immediately; the condition may already hold.
  evaluate();
}

/**
 * Block until an in-page `predicate` holds, resolving the instant it does
 * rather than on a polling tick. A notifier installed in the page
 * (see {@link installWaiter}) re-checks the predicate whenever the DOM could
 * have changed and signals the test process over a CDP binding, so an awaited
 * step idles until its condition is actually satisfied — like `select(2)` or
 * `wait` — and then proceeds immediately.
 *
 * `events` names window events that announce changes to the condition. A wait
 * naming events observes those and the DOM without polling. A wait with no
 * events also checks on a 500-millisecond backstop for unannounced changes.
 * Every wait checks once immediately, including when the event already fired.
 *
 * On a stuck condition it throws once the built-in `WAIT_FOR_CONDITION_TIMEOUT`
 * safety net elapses, naming the predicate that ran out and rendering what the
 * page held while it did. There is no caller-supplied timeout: the wait
 * resolves on the condition, and the safety net is not the common-case latency.
 *
 * Resolves with whatever the predicate answered, when that answer is a value
 * rather than `true`. The answer travels in the same notification that ends
 * the wait, so a caller acting on it acts on the page as it was when the
 * condition held, with no round trip in between for the page to change in.
 */
export const waitForCondition = async <
  A extends readonly unknown[],
  R extends PageConditionValue,
>(
  page: Page,
  predicate: PageCondition<A, R>,
  { args, events = [] }: { args?: A; events?: string[] } = {},
): Promise<R | undefined> => {
  const bindingName = `__cfcWait_${crypto.randomUUID().replace(/-/g, "")}`;
  let answer: R | undefined;
  let answerError: string | undefined;
  let predicateError: string | undefined;
  let resolveSignal!: () => void;
  const signaled = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const unsubscribe = page.onBindingCalled((name, payload) => {
    if (name !== bindingName) return;
    try {
      const parsed = JSON.parse(payload) as {
        value?: R;
        unserializable?: string;
        predicateError?: string;
      };
      // A predicate's own throw is news about a wait that is still running,
      // so it is recorded for the report and the wait carries on.
      if (parsed.predicateError !== undefined) {
        predicateError = parsed.predicateError;
        return;
      }
      answerError = parsed.unserializable;
      answer = parsed.value;
    } catch (error) {
      answerError = `the wait's notification did not parse: ${String(error)}`;
    }
    resolveSignal();
  });
  await page.addBinding(bindingName);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await page.evaluate(installWaiter, {
      args: [
        bindingName,
        predicate.toString(),
        (args ?? []) as unknown[],
        events,
      ],
    });
    const bound = waitForConditionTimeout();
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`waitForCondition did not resolve within ${bound}ms`),
          ),
        bound,
      );
    });
    try {
      await Promise.race([signaled, timedOut]);
    } catch (cause) {
      // The page is read here rather than by each caller: a wait that runs out
      // is stuck on what the page is showing, and a message saying only that
      // time ran out sends every investigation back to CI for another run.
      throw new Error(
        `${describeThrown(cause)}.\n${await describeConditionWaitFailure(
          page,
          predicate.toString(),
          args,
          predicateError,
        )}`,
        { cause },
      );
    }
    if (answerError !== undefined) {
      throw new Error(
        `The condition held, but its answer did not reach the test: ` +
          answerError,
      );
    }
    return answer;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    await page.removeBinding(bindingName).catch(() => {});
    await page.evaluate((name: string) => {
      (globalThis as typeof globalThis & {
        __cfcWaiters?: Map<string, () => void>;
      }).__cfcWaiters?.get(name)?.();
    }, { args: [bindingName] }).catch(() => {});
  }
};
