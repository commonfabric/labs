import {
  awaitViewSettled,
  getPresentationSession,
  Page,
  presentationInteractions,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { toIndentedDebugString } from "@commonfabric/data-model";
import type { RequestOutcome } from "@commonfabric/runtime-client";

/**
 * Attribute a mark predicate stamps on the element it resolved, so the test can
 * then address exactly that element. Each mark is a unique whitespace-separated
 * token in the attribute value. Grouped clicks can therefore mark the same
 * element more than once without losing an earlier target.
 */
export const CLICK_TARGET_ATTR = "data-cfc-click-target";

// Predicates evaluated in the page by `waitForCondition`. Each is self-contained
// — it closes over nothing in this module — so it can be serialized and run in
// the page. `probe` is the shadow-piercing DOM helper set; later parameters are
// the `args` passed alongside the predicate.

const textPresent = (
  probe: ProbeApi,
  selector: string,
  text: string,
): boolean =>
  probe.collect(selector).some((element) =>
    probe.deepText(element).includes(text)
  );

// Settle the view, then report whether `selector` contains `text`. Reaches the
// same answer as `textPresent` on a page that is already up to date, and drives
// one that is not: asking the worker whether it is idle queues runnable pull
// work that nothing else would start, so a rendering that only the page's own
// pending work produces arrives on a settling check and not on one that watches
// the DOM alone.
const settledTextPresent = async (
  probe: ProbeApi,
  selector: string,
  text: string,
): Promise<boolean> => {
  const settle = (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled;
  if (!settle) return false;
  await settle();
  return probe.collect(selector).some((element) =>
    probe.deepText(element).includes(text)
  );
};

const textAbsent = (
  probe: ProbeApi,
  selector: string,
  text: string,
): boolean =>
  !probe.collect(selector).some((element) =>
    probe.deepText(element).includes(text)
  );

// Resolve a control's disabled state and compare it to `disabled`. An inner
// <button> is authoritative when present: its `.disabled` DOM property is the
// control's real state. Without one, fall back to the host — a native form
// control exposes `.disabled`, and a custom element like cf-checkbox reflects
// `disabled` to an attribute and also sets `aria-disabled`. A control that is
// neither disabled nor carries the attribute resolves to enabled, so
// `waitForDisabled(el, false)` satisfies immediately instead of hanging.
const disabledIs = (
  probe: ProbeApi,
  selector: string,
  disabled: boolean,
): boolean => {
  const element = probe.collect(selector)[0];
  if (!element) return false;
  const button = element instanceof HTMLButtonElement
    ? element
    : element.shadowRoot?.querySelector("button");
  let resolved: boolean;
  if (button instanceof HTMLButtonElement) {
    resolved = button.disabled;
  } else if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    resolved = element.disabled;
  } else {
    resolved = element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true";
  }
  return resolved === disabled;
};

const runtimeIdle = async (): Promise<boolean> => {
  const rt = (globalThis as typeof globalThis & {
    commonfabric?: { rt?: { idle?: () => Promise<void> } };
  }).commonfabric?.rt;
  if (!rt?.idle) return false;
  await rt.idle();
  return true;
};

const runtimeSynced = async (): Promise<boolean> => {
  const rt = (globalThis as typeof globalThis & {
    commonfabric?: { rt?: { allSynced?: () => Promise<void> } };
  }).commonfabric?.rt;
  if (!rt?.allSynced) return false;
  await rt.allSynced();
  return true;
};

// RootView resolves a named view space independently of URL/login state, and
// AppView then loads that space's active root asynchronously. A previous root
// can remain interactive during that handoff, so readiness means the rendered
// active PieceHandle itself belongs to the expected space.
const activeSpaceRootReady = (
  _probe: ProbeApi,
  expectedSpace: string,
): boolean => {
  // `globalThis.app` is the shell's root element.
  const root = (globalThis as typeof globalThis & {
    app?: HTMLElement & { getRuntimeSpaceDID(): string | undefined };
  }).app;
  const appView = root?.shadowRoot?.querySelector("x-app-view") as
    | (HTMLElement & {
      space?: string;
      _patterns?: {
        value?: {
          activePattern?: { cell(): { space(): string } };
        };
      };
    })
    | null
    | undefined;
  const activePattern = appView?._patterns?.value?.activePattern;
  return root?.getRuntimeSpaceDID() === expectedSpace &&
    appView?.space === expectedSpace &&
    activePattern?.cell().space() === expectedSpace;
};

const viewSettledReady = (): boolean =>
  typeof (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled === "function";

// Settle the view, then fill the input behind `selector` and report whether the
// value took. The settle drives the page rather than watching it: asking the
// worker whether it is idle queues runnable pull work that nothing else would
// start, so a field that only the page's own pending work renders arrives on a
// settling check and not on one that reads the DOM alone. A not-yet-ready field
// (absent, hidden, disabled, read-only) reports false without dispatching
// anything, so a re-check on the next DOM mutation retries the fill; a ready
// field is filled once and verified.
//
// Each invocation keeps a progress ledger on `globalThis.__cfFillDiag`
// (per selector): which phase it reached and when. waitForCondition never
// re-enters a predicate whose promise is still pending, so if one of the
// awaits below stalls (typically `commit()` waiting on a stuck cell
// round-trip), the ledger's `phase` names the exact await the fill died in —
// that is what `readCfInputProbe` reports on timeout.
const fillAndVerify = async (
  probe: ProbeApi,
  selector: string,
  nextValue: string,
): Promise<boolean> => {
  type FillDiag = {
    attempts: number;
    phase: string;
    phaseAt: number;
    startedAt: number;
    commitStartedAt?: number;
    lastInputValue?: string;
  };
  const registry = ((globalThis as typeof globalThis & {
    __cfFillDiag?: Record<string, FillDiag>;
  }).__cfFillDiag ??= {});
  const diag: FillDiag = {
    attempts: (registry[selector]?.attempts ?? 0) + 1,
    phase: "settling",
    phaseAt: Date.now(),
    startedAt: Date.now(),
  };
  registry[selector] = diag;
  const phase = (name: string) => {
    diag.phase = name;
    diag.phaseAt = Date.now();
  };

  // The ledger is written above this point so that a page which never exposes
  // `viewSettled` names that in the failure probe.
  const settle = (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled;
  if (!settle) {
    phase("no-settle");
    return false;
  }
  await settle();
  phase("settled");

  const element = probe.collect(selector)[0];
  if (!element) {
    phase("no-element");
    return false;
  }
  const input = element instanceof HTMLInputElement
    ? element
    : element.shadowRoot?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    phase("no-inner-input");
    return false;
  }

  // Rendered, not on-screen: the fill drives the field through focus and
  // dispatched events rather than a coordinate click, so its viewport position
  // never bears on whether the value takes.
  if (!probe.isRendered(input) || input.disabled || input.readOnly) {
    phase("not-fillable");
    return false;
  }

  const root = input.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : element;
  // The host component owns durably committing a typed edit. A cf-input two-way
  // bound to a Cell flushes the value into the cell and awaits the runtime
  // round-trip via commit(); a field with no cell (cf-submit-input) exposes no
  // commit() and its DOM value is authoritative. Drive the DOM like a user and
  // then ask the host to commit, rather than reaching into the cell.
  const hostElement = host as Element & {
    commit?: () => Promise<void>;
    requestUpdate?: () => void | Promise<void>;
  };

  phase("dispatching");
  input.focus();
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (valueSetter) valueSetter.call(input, nextValue);
  else input.value = nextValue;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  input.blur();

  // Ask the host to flush and durably commit the typed value (a no-op for
  // fields not bound to a cell), then re-render so the inner input reflects the
  // committed value before we read it back.
  phase("committing");
  diag.commitStartedAt = Date.now();
  await hostElement.commit?.();
  phase("committed");
  await hostElement.requestUpdate?.();
  phase("update-requested");
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );

  // A commit that re-renders the host replaces the control. The input this fill
  // typed into is then detached and still holds the typed text, so resolve the
  // selector again and require the same nodes before reading the value off it.
  // A replaced control reports false, and the next page pulse fills the control
  // that took its place.
  const liveElement = probe.collect(selector)[0];
  const liveInput = liveElement instanceof HTMLInputElement
    ? liveElement
    : liveElement?.shadowRoot?.querySelector("input");
  diag.lastInputValue = liveInput instanceof HTMLInputElement
    ? liveInput.value
    : undefined;
  if (liveElement !== element || liveInput !== input) {
    phase("target-replaced");
    return false;
  }

  const verified = input.value === nextValue;
  phase(verified ? "verified" : "value-mismatch");
  return verified;
};

/**
 * Which elements a marked click is about to be aimed at.
 *
 * A finder returns the elements to mark, in the order their tokens were
 * supplied, or `undefined` when the page does not yet present all of them. It
 * decides only which elements qualify — being rendered, surviving a settle, and
 * carrying the mark are {@link settleAndMarkTargets}'s business, and every
 * marked click goes through that one shared step.
 *
 * A finder is serialized into the page as its own source, so it closes over
 * nothing in this module and reads only what it is passed.
 */
export type ClickTargetFinder<A extends readonly unknown[]> = (
  probe: ProbeApi,
  ...args: A
) => readonly HTMLElement[] | undefined;

/** What {@link settleAndMarkTargets} is called with, ready to serialize. */
export type MarkTargetsArgs = [
  finderSource: string,
  finderArgs: readonly unknown[],
  tokens: readonly string[],
  attr: string,
  onMarkSource: string | null,
];

/**
 * Spell out one call to {@link settleAndMarkTargets}. The wait that places the
 * mark and the aim that places it again on whatever replaced a rebuilt control
 * both run these same arguments, so they mark under the same rules.
 */
export const markTargetsArgs = <A extends readonly unknown[]>(
  finder: ClickTargetFinder<A>,
  finderArgs: A,
  tokens: readonly string[],
  onMark?: (target: HTMLElement) => void,
): MarkTargetsArgs => [
  finder.toString(),
  finderArgs,
  tokens,
  CLICK_TARGET_ATTR,
  onMark ? onMark.toString() : null,
];

/**
 * Resolve every click target with `finderSource`, settle the view, and mark the
 * targets only when the same rendered elements survive the settle.
 *
 * Being in the DOM is not being clickable. The reactive scheduler runs in a
 * worker while the DOM lives on the main thread, so a control can be found by a
 * selector while the vdom batch that binds its click handler is still crossing
 * to the main thread, and while the Lit update cycle that removes its
 * `pointer-events: none` is still pending. A click delivered to that control is
 * dropped without a trace. Settling covers all three stages, and a click helper
 * that skips it can hand a test a control that takes the click and does nothing
 * with it.
 *
 * The settle sits between two resolutions rather than before the wait, because
 * a target that arrives partway through a settle was never covered by it. Both
 * resolutions have to answer the same elements, so what gets marked is the
 * element the settle ran for. A target introduced or replaced during the settle
 * fails that comparison, and the next DOM mutation re-enters this predicate and
 * gives whatever took its place a settle of its own.
 *
 * The settle also drives the page forward rather than watching it. Asking the
 * worker whether it is idle queues runnable pull work that nothing else would
 * start, so a target reached only by the page's own pending work arrives on a
 * settling check and never on one that reads the DOM alone.
 *
 * `onMarkSource`, when supplied, runs on each element once it carries its mark
 * and inside this same page turn — for a caller that has to attach something to
 * the exact element the click will reach.
 */
export const settleAndMarkTargets = async (
  probe: ProbeApi,
  finderSource: string,
  finderArgs: readonly unknown[],
  tokens: readonly string[],
  attr: string,
  onMarkSource: string | null,
): Promise<boolean> => {
  const settle = (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled;
  if (!settle) return false;

  const finder = new Function("return (" + finderSource + ")")() as (
    probe: ProbeApi,
    ...args: readonly unknown[]
  ) => readonly HTMLElement[] | undefined;
  const onMark = onMarkSource === null ? undefined : new Function(
    "return (" + onMarkSource + ")",
  )() as (target: HTMLElement) => void;
  const clickable = (target: HTMLElement): boolean =>
    target.isConnected && probe.isRendered(target);

  // The settle runs whether or not the targets are there yet, because it is
  // what drives the page: a target reached only by the page's own pending work
  // arrives on a settle, and a predicate that returned early on a missing
  // target would be waiting for a page nothing is moving.
  const before = finder(probe, ...finderArgs);
  const readyBefore = before !== undefined &&
    before.length === tokens.length &&
    before.every(clickable);

  await settle();

  if (!readyBefore || before === undefined) return false;
  const after = finder(probe, ...finderArgs);
  if (!after || after.length !== before.length) return false;
  if (
    !after.every((target, index) =>
      target === before[index] && clickable(target)
    )
  ) return false;

  for (let index = 0; index < after.length; index++) {
    const target = after[index];
    const token = tokens[index];
    if (target === undefined || token === undefined) return false;
    probe.addToken(target, attr, token);
    onMark?.(target);
  }
  return true;
};

// The first enabled element matching each selector, reached through a host's
// shadow root when the host wraps the control that takes the click.
//
// A disabled control is passed over, and a selector all of whose matches are
// disabled is not answered at all, so the wait holds until the page enables
// one. Such a control takes no click: the browser raises none on it, and
// `cf-button` additionally gives it `pointer-events: none`, which sends the
// press to the host that wraps it. Either way the control is not activated, and
// the aim keeps missing until it repeats a pixel and reports. Disabled-ness is
// asked of both the host and the control it wraps, because `disabled` does not
// inherit and a host can carry an `aria-disabled` its inner control does not.
const findSelectorClickTargets = (
  probe: ProbeApi,
  selectors: readonly string[],
): readonly HTMLElement[] | undefined => {
  const clickTarget = (element: Element): HTMLElement =>
    (element.shadowRoot?.querySelector("[data-cf-button]") as
      | HTMLElement
      | null) ?? element as HTMLElement;

  const targets: HTMLElement[] = [];
  for (const selector of selectors) {
    const host = probe.collect(selector).find((match) =>
      !probe.isDisabled(match) && !probe.isDisabled(clickTarget(match))
    );
    if (!host) return undefined;
    targets.push(clickTarget(host));
  }
  return targets;
};

// The first element matching `selector`, taken directly. The selector resolves
// to the field itself, since a `cf-submit-input` forwards its `inputId` to the
// inner `<input>`.
const findKeyboardTarget = (
  probe: ProbeApi,
  selector: string,
): readonly HTMLElement[] | undefined => {
  const target = probe.collect(selector)[0] as HTMLElement | undefined;
  return target ? [target] : undefined;
};

// Focus the field that carries the mark, so the key press that follows reaches
// the element the settle ran for.
const focusMarkedTarget = (target: HTMLElement): void => {
  target.focus();
};

// The `index`-th element matching `selector`, once it and its wrapped control
// are enabled. The index includes disabled matches so enabling a control does
// not change which one the click targets.
const findNthClickTarget = (
  probe: ProbeApi,
  selector: string,
  index: number,
): readonly HTMLElement[] | undefined => {
  const target = probe.collect(selector)[index] as HTMLElement | undefined;
  if (!target || probe.isDisabled(target)) return undefined;
  const root = target.getRootNode();
  if (root instanceof ShadowRoot && probe.isDisabled(root.host)) {
    return undefined;
  }
  const inner = target.shadowRoot?.querySelector("[data-cf-button]");
  if (inner && probe.isDisabled(inner)) return undefined;
  return [target];
};

// The first rendered, enabled element carrying `data-ui-action="<action>"`.
// Rendered-ness is asked of the resolved click target, which covers the host:
// hiding the host reaches the inner control either way. It is asked without an
// on-screen requirement, since the trusted click scrolls the target into view
// before dispatching. Disabled-ness is asked of both, because a host can carry
// an `aria-disabled` its inner control does not.
const findTrustedActionTarget = (
  probe: ProbeApi,
  action: string,
): readonly HTMLElement[] | undefined => {
  const clickTarget = (element: Element): HTMLElement =>
    (element.shadowRoot?.querySelector("[data-cf-button]") as
      | HTMLElement
      | null) ?? element as HTMLElement;

  for (const element of probe.collect(`[data-ui-action="${action}"]`)) {
    const target = element as HTMLElement;
    const inner = clickTarget(target);
    if (
      probe.isRendered(inner) &&
      !probe.isDisabled(target) && !probe.isDisabled(inner)
    ) {
      return [inner];
    }
  }
  return undefined;
};

// Record the provenance of the next click the marked control receives, so a
// failure can show whether the dispatch was trusted and where it landed.
// Attached to the control that carries the mark, which is the control the
// trusted click is aimed at.
const recordTrustedActionClick = (clickTarget: HTMLElement): void => {
  clickTarget.addEventListener(
    "click",
    (event) => {
      (globalThis as typeof globalThis & {
        __lastCfcTrustedActionClick?: TrustedActionProbe["lastClick"];
      }).__lastCfcTrustedActionClick = {
        trusted: event.isTrusted,
        path: event.composedPath().flatMap((node) => {
          if (!(node instanceof HTMLElement)) return [];
          const dataset: Record<string, string> = {};
          for (const key in node.dataset) {
            dataset[key] = node.dataset[key] ?? "";
          }
          return [{
            tagName: node.tagName.toLowerCase(),
            id: node.id,
            dataset,
          }];
        }),
      };
    },
    { capture: true, once: true },
  );
};

// Resolve once the shell's reactive view has caught up to runtime state and is
// interactive, so a click lands on a bound handler. Waits for the shell to
// expose `viewSettled` (notification-driven), then awaits the settle. Neither
// wait takes a timeout: the readiness poll carries `waitForCondition`'s built-in
// safety net, and the settle itself awaits a real promise.
export async function settleView(page: Page): Promise<void> {
  await waitForCondition(page, viewSettledReady);
  await awaitViewSettled(page);
}

// Built-in safety net for a genuinely stuck settle, matching
// `waitForCondition`'s precedent. The loop resolves the instant the text
// appears and drives a real view settle between checks, so this bound is never
// the common-case latency; it is generous enough to cover the slowest
// legitimate effect (cross-browser propagation of an optimistic write) without
// capping a check that is still making progress.
const WAIT_FOR_TEXT_WHILE_SETTLING_TIMEOUT = 300_000; // 5 minutes

/**
 * Wait for `selector` to contain `text` after a stimulus has been dispatched,
 * driving the shell to settle between checks and resolving the instant the text
 * appears.
 *
 * A freshly dispatched click's effect reaches the DOM only once the worker→main
 * pipeline runs: the worker settles the reactive graph, pushes a vdom batch,
 * the main thread applies it, and Lit drains its updates. `awaitViewSettled`
 * pumps that pipeline. An integration test holds no UI subscription, so nothing
 * else pumps it — a purely passive wait can sit on a DOM that never changes and
 * time out even though the effect is ready to apply.
 *
 * Each iteration awaits one full view settle, then re-checks. The settle is the
 * re-evaluation trigger — real asynchronous work (a worker idle round-trip plus
 * a drained Lit cycle), not a fixed-interval sleep — so the effect is observed
 * within a settle cycle or two and the wait resolves immediately once it holds.
 * The settle must be driven from the same call sequence as the check; running
 * it concurrently with a separate waiter does not help, because the astral CDP
 * connection serializes evaluations.
 */
async function waitForTextWhileSettling(
  page: Page,
  selector: string,
  text: string,
): Promise<void> {
  const deadline = Date.now() + WAIT_FOR_TEXT_WHILE_SETTLING_TIMEOUT;
  if (await textIsPresent(page, selector, text)) return;
  do {
    await awaitViewSettled(page);
    if (await textIsPresent(page, selector, text)) return;
  } while (Date.now() < deadline);
  throw new Error(
    `"${selector}" did not contain "${text}" within ` +
      `${WAIT_FOR_TEXT_WHILE_SETTLING_TIMEOUT}ms`,
  );
}

export async function clickTrustedAction(
  page: Page,
  action: string,
) {
  const token = `trusted-action-${crypto.randomUUID()}`;
  let probe: TrustedActionProbe | undefined;
  try {
    // Wait until a visible, enabled instance of the action has settled and can
    // be marked, then click it exactly once. Marking attaches the provenance
    // listener, so the single click is the trusted dispatch we record.
    const args = markTargetsArgs(
      findTrustedActionTarget,
      [action],
      [token],
      recordTrustedActionClick,
    );
    await waitForCondition(page, settleAndMarkTargets, { args });
    await clickMarked(page, {
      token,
      remark: { predicate: settleAndMarkTargets, args },
    });
    await settleView(page);
  } catch (cause) {
    probe ??= await readTrustedActionProbe(page, action).catch(() => undefined);
    // Indented for readable test-log output
    throw new Error(
      `Timed out clicking trusted action "${action}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

/**
 * Submit a `cf-submit-input` from the keyboard: focus its inner field and press
 * a real Enter. The field sits inside a `<form>` with a hidden native submit
 * button, so Enter triggers the browser's implicit form submission, which fires
 * a trusted click on that button — carrying the typed text to the host exactly
 * like the visible button's click. The Enter must be a real CDP key press: a
 * scripted `KeyboardEvent` does not trigger implicit submission, which is why an
 * earlier dispatched-keydown attempt never reached the create handler.
 *
 * The field is resolved either side of a settle and focused only once the same
 * element survives it, the way a marked click resolves the control it clicks.
 * A field focused without that is a field whose form may not be wired up yet,
 * and the Enter then reaches a submit button with no handler bound.
 */
export async function submitViaEnter(
  page: Page,
  inputSelector: string,
) {
  const token = `cf-submit-input-${crypto.randomUUID()}`;
  const args = markTargetsArgs(
    findKeyboardTarget,
    [inputSelector],
    [token],
    focusMarkedTarget,
  );
  try {
    await waitForCondition(page, settleAndMarkTargets, { args });
  } catch (cause) {
    const probe = await readTextProbe(page, inputSelector).catch(() =>
      undefined
    );
    throw new Error(
      `Timed out waiting for ${inputSelector} to settle before pressing ` +
        `Enter. Last probe: ${toIndentedDebugString(probe)}`,
      { cause },
    );
  }
  await page.keyboard.press("Enter");
  await clearClickMark(page, token).catch(() => {});
  await settleView(page);
}

export async function clickTrustedActionAndWaitForText(
  page: Page,
  action: string,
  selector: string,
  text: string,
) {
  let actionProbe: TrustedActionProbe | undefined;
  let textProbe: TextProbe | undefined;

  // Fast path: the effect may already be present (idempotent re-entry).
  if (await textIsPresent(page, selector, text)) {
    return;
  }

  // Settle the view BEFORE dispatching, then click the trusted action exactly
  // ONCE. Settling first means the action's handler is bound when the single
  // trusted click lands; re-dispatching on a later tick is what double-fires
  // and corrupts the event provenance, so we never re-click.
  try {
    await settleView(page);
    await clickTrustedAction(page, action);
  } catch (cause) {
    actionProbe = await readTrustedActionProbe(page, action).catch(() =>
      undefined
    );
    textProbe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Failed to click trusted action "${action}" while waiting for "${selector}" to contain "${text}". Last probes: ${
        toIndentedDebugString({ actionProbe, textProbe })
      }`,
      { cause },
    );
  }

  // The click is delivered; wait for its effect, resolving the instant the
  // text appears while driving the settle that applies it. No re-clicking — an
  // optimistic perUser/perSpace write whose chip trails the commit is caught by
  // the same wait.
  try {
    await waitForTextWhileSettling(page, selector, text);
  } catch (cause) {
    actionProbe ??= await readTrustedActionProbe(page, action).catch(() =>
      undefined
    );
    textProbe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out clicking trusted action "${action}" until "${selector}" contained "${text}". Last probes: ${
        toIndentedDebugString({ actionProbe, textProbe })
      }`,
      { cause },
    );
  }
}

export async function waitForText(
  page: Page,
  selector: string,
  text: string,
) {
  try {
    await waitForCondition(page, textPresent, {
      args: [selector, text],
    });
  } catch (cause) {
    const probe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out waiting for "${selector}" to contain "${text}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

/**
 * Wait for `selector` to contain `text`, settling `page` on each check.
 *
 * Reach for this rather than `waitForText` when the text is the effect of a
 * stimulus — this page's own click, or one delivered to another browser sharing
 * the piece. `waitForText` only watches the DOM, and an integration test holds
 * no UI subscription, so nothing drives the page between its checks. A rendering
 * that the page's own pending work has to produce then never arrives, and the
 * wait runs to the stuck-condition safety net on a page that was one settle away
 * from showing it.
 *
 * The settle is inside the predicate, so each re-check drives the page and reads
 * the result of that same drive.
 */
export async function waitForSettledText(
  page: Page,
  selector: string,
  text: string,
) {
  try {
    await waitForCondition(page, settledTextPresent, {
      args: [selector, text],
    });
  } catch (cause) {
    const probe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out waiting for "${selector}" to contain "${text}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

export async function waitForTextAbsent(
  page: Page,
  selector: string,
  text: string,
) {
  try {
    await waitForCondition(page, textAbsent, {
      args: [selector, text],
    });
  } catch (cause) {
    const probe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out waiting for "${selector}" not to contain "${text}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

export async function fillCfInput(
  page: Page,
  selector: string,
  value: string,
) {
  try {
    const presentation = presentationInteractions(page);
    if (presentation) {
      await presentation.typeIntoCfInput(selector, value);
    } else {
      await waitForCondition(page, fillAndVerify, {
        args: [selector, value],
      });
    }
  } catch (cause) {
    const probe = await readCfInputProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out filling cf input "${selector}" with "${value}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

/**
 * Read the current value of a cf-input's inner input element. Throws when the
 * selector does not resolve to an actual input, so an absent control cannot
 * masquerade as an empty value in assertions.
 */
export async function readCfInputValue(
  page: Page,
  selector: string,
): Promise<string> {
  const field = await page.waitForSelector(selector, {
    strategy: "pierce",
  });
  const probe = await field.evaluate(
    (element: Element): { found: boolean; value: string } => {
      const input = element instanceof HTMLInputElement
        ? element
        : element.shadowRoot?.querySelector("input");
      return input instanceof HTMLInputElement
        ? { found: true, value: input.value }
        : { found: false, value: "" };
    },
  );
  if (!probe.found) {
    throw new Error(`"${selector}" did not resolve to an input element`);
  }
  return probe.value;
}

/**
 * Fill the native `<textarea>` a `cf-textarea` wraps, and let the blur commit
 * it.
 *
 * Separate from {@link fillCfInput} because that one drives an `<input>`: it
 * resolves `element.shadowRoot?.querySelector("input")` and gives up on a host
 * that has none. This drives the field as a person does — focus, set the value,
 * dispatch `input` and `change`, then blur.
 *
 * The blur is what commits the draft, and it is load-bearing rather than
 * tidiness. `cf-textarea` defaults to the `debounce` timing strategy at 300ms,
 * and its blur handler reaches `InputTimingController.onBlur` by way of its
 * cell controller; that method runs the pending callback at once rather than
 * waiting the timer out. Without the blur the write waits out the debounce
 * instead, which a caller clicking a submit control on the next line does not
 * wait for.
 *
 * There is no `commit()` to call on this host: `cf-input` declares one and
 * `cf-textarea` does not.
 *
 * Presentation mode does not animate this fill. `typeIntoCfInput`, the
 * presentation path {@link fillCfInput} routes through, resolves an
 * `HTMLInputElement` and throws for anything else, so a recorded run shows the
 * text arriving in the field rather than being typed into it.
 */
export async function fillCfTextarea(
  page: Page,
  selector: string,
  value: string,
) {
  await waitForRuntimeIdle(page);
  const field = await page.waitForSelector(selector, {
    strategy: "pierce",
  });
  // Two ways to come back empty-handed, reported apart: a selector that names
  // no textarea is a different defect from one that names a textarea the fill
  // did not take, and a single message for both asserts whichever cause it
  // happens to name.
  const outcome = await field.evaluate((element: Element, nextValue) => {
    const textarea = element instanceof HTMLTextAreaElement
      ? element
      : element.shadowRoot?.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) return "no-textarea";
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(textarea, nextValue);
    else textarea.value = nextValue;
    textarea.dispatchEvent(
      new Event("input", { bubbles: true, composed: true }),
    );
    textarea.dispatchEvent(
      new Event("change", { bubbles: true, composed: true }),
    );
    textarea.blur();
    return textarea.value === nextValue ? "filled" : "value-mismatch";
  }, { args: [value] });
  if (outcome === "no-textarea") {
    throw new Error(`"${selector}" did not resolve to a textarea`);
  }
  if (outcome !== "filled") {
    throw new Error(
      `"${selector}" resolved a textarea that did not take the value`,
    );
  }
}

/**
 * Write the whole of `data` to `stream`, which one `writeSync` may not do.
 *
 * `writeSync` is synchronous, not complete: it returns the number of bytes it
 * took, and a pipe that is full takes fewer than it was offered. A bench file's
 * diagnostics reach the Benchmarks workflow through exactly such a pipe and
 * carry whole sample dumps, so a single call can truncate one with nothing to
 * say it did.
 *
 * `@std/io` is not mapped here, so the loop is written out, as
 * `packages/cli/lib/view/mod.ts` writes it for stdout.
 *
 * @throws If the stream takes no bytes, rather than looping forever offering
 *   them.
 */
export function writeAllSync(
  stream: { writeSync(data: Uint8Array): number },
  data: Uint8Array,
): void {
  let written = 0;
  while (written < data.length) {
    const took = stream.writeSync(data.subarray(written));
    if (took <= 0) {
      throw new Error(`The stream accepted no bytes of ${data.length}.`);
    }
    written += took;
  }
}

export async function waitForRuntimeIdle(
  page: Page,
) {
  await waitForCondition(page, runtimeIdle);
}

export async function waitForActiveSpaceRoot(
  page: Page,
  expectedSpace: string,
) {
  await waitForCondition(page, activeSpaceRootReady, {
    args: [expectedSpace],
  });
}

export async function waitForDisabled(
  page: Page,
  selector: string,
  disabled: boolean,
) {
  try {
    await waitForCondition(page, disabledIs, {
      args: [selector, disabled],
    });
  } catch (cause) {
    const probe = await readDisabledProbe(page, selector).catch(() =>
      undefined
    );
    throw new Error(
      `Timed out waiting for ${selector} disabled=${disabled}. Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

/**
 * Resolve once every selector identifies the same rendered target before and
 * after one settle. Mark those exact targets for the subsequent clicks.
 *
 * Every target is ready before any target is marked. A grouped dispatch can
 * therefore click all of its marks without a settle between them.
 */
async function settleWithClickTargets(
  page: Page,
  selectors: readonly string[],
): Promise<string[]> {
  const tokens = selectors.map(() => `cf-button-${crypto.randomUUID()}`);
  try {
    await waitForCondition(page, settleAndMarkTargets, {
      args: markTargetsArgs(findSelectorClickTargets, [selectors], tokens),
    });
  } catch (cause) {
    await Promise.all(
      tokens.map((token) => clearClickMark(page, token).catch(() => {})),
    );
    // Matches per selector, so the failure names which of a grouped dispatch's
    // targets never came within reach of a click. Each match's `rect`,
    // `visible` and `disabled` report which of the three it was: absent,
    // present without a layout box, or present and declining the click. Every
    // probe reads the same page, so the body text is reported once rather than
    // once per selector.
    const probes = await Promise.all(
      selectors.map((selector) =>
        readTextProbe(page, selector).catch(() => undefined)
      ),
    );
    // Indented for readable test-log output
    throw new Error(
      `Timed out waiting for ${
        selectors.join(", ")
      } to be clickable. Last probe: ${
        toIndentedDebugString({
          matches: Object.fromEntries(
            selectors.map((selector, index) => [
              selector,
              probes[index]?.matches,
            ]),
          ),
          bodyText: probes.find((probe) => probe !== undefined)?.bodyText,
        })
      }`,
      { cause },
    );
  }
  return tokens;
}

export async function clickCfButton(
  page: Page,
  selector: string,
) {
  const [token] = await settleWithClickTargets(page, [selector]);
  if (token === undefined) {
    throw new Error(`Unable to mark ${selector} for click.`);
  }
  await clickMarked(page, {
    token,
    remark: {
      predicate: settleAndMarkTargets,
      args: markTargetsArgs(findSelectorClickTargets, [[selector]], [token]),
    },
  });
  await settleView(page);
}

/**
 * Settle every target page before dispatch, with all of that page's targets
 * already rendered. Mark every target before the first click. Dispatch every
 * click without an intervening view settle. Settle every target page after
 * dispatch.
 */
export async function clickCfButtonsConcurrently(
  targets: readonly { page: Page; selector: string }[],
): Promise<void> {
  const pages = [...new Set(targets.map(({ page }) => page))];
  const markedByPage = pages.map((page) => ({
    page,
    tokens: [] as string[],
  }));
  const markResults = await Promise.allSettled(
    markedByPage.map(async ({ page, tokens }) => {
      tokens.push(
        ...await settleWithClickTargets(
          page,
          targets.filter((target) => target.page === page).map(
            ({ selector }) => selector,
          ),
        ),
      );
    }),
  );
  const clearMarks = () =>
    Promise.all(
      markedByPage.flatMap(({ page, tokens }) =>
        tokens.map((token) => clearClickMark(page, token).catch(() => {}))
      ),
    );
  const markFailure = markResults.find((result) =>
    result.status === "rejected"
  );
  if (markFailure) {
    await clearMarks();
    throw markFailure.reason;
  }

  const clickResults = await Promise.allSettled(
    markedByPage.map(async ({ page, tokens }) => {
      for (const token of tokens) {
        await clickMarked(page, token);
      }
    }),
  );
  await clearMarks();
  const clickFailure = clickResults.find((result) =>
    result.status === "rejected"
  );
  const settleResults = await Promise.allSettled(
    pages.map((page) => settleView(page)),
  );
  if (clickFailure) {
    throw clickFailure.reason;
  }
  const settleFailure = settleResults.find((result) =>
    result.status === "rejected"
  );
  if (settleFailure) {
    throw settleFailure.reason;
  }
}

/**
 * Click the `index`-th element matching `selector`, where the selector already
 * resolves to the clickable elements themselves (for example `[data-cf-button]`
 * across a rendered piece) rather than to a host wrapping one.
 *
 * The wait is the mark: a `waitForCondition` predicate re-checks on each DOM
 * mutation until the indexed element is present and visible, settles the view
 * around it, and tags it. The test then dispatches a single trusted click on
 * the tagged element and settles the view again so the click's local effect is
 * in the DOM when the next step looks for it.
 */
export async function clickNthCfButton(
  page: Page,
  selector: string,
  index: number,
) {
  const token = `cf-nth-button-${crypto.randomUUID()}`;
  const args = markTargetsArgs(findNthClickTarget, [selector, index], [token]);
  try {
    await waitForCondition(page, settleAndMarkTargets, { args });
  } catch (cause) {
    const probe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Unable to find button #${index} matching "${selector}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
  await clickMarked(page, {
    token,
    remark: { predicate: settleAndMarkTargets, args },
  });
  await settleView(page);
}

// Where a trusted click is about to be aimed, or why the marked control could
// not be aimed at.
type ClickAim =
  | { x: number; y: number; targetId: number }
  | { missing: true; sawTarget: boolean }
  | {
    offPage: true;
    box: { x: number; y: number; width: number; height: number };
    page: { width: number; height: number };
  };

/**
 * What became of the trusted click the aim armed for.
 *
 * `hit` means the click reached the marked control. `missed` means it reached
 * something else. `pending` means no click event was raised at all.
 *
 * A control that declines the interaction leaves either one, depending on how
 * it declines. A disabled control takes the press and produces no click, which
 * is `pending`. One a stylesheet has additionally given `pointer-events: none`,
 * as `cf-button` gives a disabled control, does not take the press either: it
 * reaches the host that wraps the control, which raises a click the mark is
 * absent from, and that is `missed`.
 *
 * Neither `missed` nor `pending` activated the control, so the click can be
 * aimed again.
 */
type ClickLanding = {
  verdict: "pending" | "hit" | "missed";

  /** The innermost few elements the interaction did reach, outward. */
  path: string;
};

// Resolve the marked control, hold until it has a settled layout box, scroll it
// into view, and answer with the point to click — all inside one page turn.
//
// The control is settled when it is rendered (laid out, not display:none or
// visibility:hidden) with an unchanged bounding rect across two consecutive
// animation frames. A surface that is still settling — a join card's profile
// surface toggling display through its entrance, a re-render relaying out the
// region — shifts or drops the box, and the wait keeps holding; it drops its
// baseline whenever the box disappears, so a control hidden partway through is
// picked up once it returns rather than aimed at mid-shift.
//
// The point is measured here rather than by the test process because the two
// used to be separated by several protocol round trips, and the page is free to
// rebuild in that gap. What it rebuilt away was the very control the wait had
// just declared settled, so the measurement found no box and the click reported
// "Unable to get stable box model to click on". Deciding and measuring in the
// same turn leaves nothing between them.
//
// The point is the middle of the part of the control's box that lies inside
// the page, which for a control the page has room for is the middle of the
// whole box. A control with no part of it inside the page is reported: the
// browser accepts a click dispatched outside the page, delivers it to nothing,
// and reports no error for having done so, so aiming there would leave a caller
// told the control was pressed.
//
// A mark that is absent from the start is reported rather than waited on: the
// caller placed it a moment ago, so its absence means the control it names was
// replaced, which no amount of further waiting resolves. `remarkSource`, when
// the caller supplies it, is the mark predicate's own source; running it again
// re-establishes the mark on whatever control took the old one's place, so a
// rebuilt surface is clicked rather than reported.
//
// Answering also arms the landing interceptor, which decides the trusted click
// that follows. The interceptor is armed here rather than by the test process
// so that it is in place from the instant the point is measured, leaving no
// window in which an interaction could arrive unwatched.
const aimAtMarkedTarget = async (
  probe: ProbeApi,
  selector: string,
  remarkSource: string | null,
  remarkArgs: readonly unknown[],
  identityKey: string,
): Promise<ClickAim | false> => {
  type AimDiag = { phase: string; frames: number; lastBox: string };
  const registry = ((globalThis as typeof globalThis & {
    __cfAimDiag?: Record<string, AimDiag>;
  }).__cfAimDiag ??= {});
  const diag: AimDiag = { phase: "resolving", frames: 0, lastBox: "none" };
  registry[selector] = diag;

  type Landing = {
    verdict: "pending" | "hit" | "missed";

    /** Whether the interaction's first event carried the mark. */
    onTarget: boolean | undefined;
    path: string;
    armed: boolean;
    detach: () => void;
  };
  const landings = ((globalThis as typeof globalThis & {
    __cfClickLanding?: Record<string, Landing>;
  }).__cfClickLanding ??= {});
  const open = ((globalThis as typeof globalThis & {
    __cfClickLandingOpen?: Record<string, true>;
  }).__cfClickLandingOpen ??= {});

  // Watch the pointer and mouse events of one trusted click, at the window and
  // in the capture phase.
  //
  // The first event decides what happens to the rest: its composed path either
  // carries the mark, and every event of the interaction goes through, or it
  // does not, and every event is stopped there. One decision covers the whole
  // interaction, so the control takes the press and the release together or
  // takes neither.
  //
  // The verdict is settled at the click event, which is the event a control
  // acts on. The press and the release cross the protocol separately, so the
  // page can carry the control away between them, and the browser then raises
  // the click on the nearest ancestor the two have in common. A click that does
  // not carry the mark is stopped like any other miss.
  //
  // What is stopped is the press, the release and the click. The pointer moves
  // to the point before the press, and the hover events that produces are the
  // page's to handle.
  //
  // Only trusted events are watched. The page raises clicks of its own — a
  // label forwarding to its control, a component clicking itself from a key
  // handler — and those pass through untouched and leave the verdict alone.
  //
  // Arming is gated on the entry the test process opens for this click and
  // removes when the click is done, so a wait that outlived its caller cannot
  // leave an interceptor behind.
  const arm = (): void => {
    if (!open[selector]) return;
    landings[selector]?.detach();
    const carriesMark = (event: Event): boolean =>
      event.composedPath().some((node) =>
        node instanceof Element && node.matches(selector)
      );
    const describe = (event: Event): string =>
      event.composedPath()
        .flatMap((node) =>
          node instanceof Element
            ? [node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "")]
            : []
        )
        .slice(0, 4)
        .join(" < ");
    const block = (event: Event): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onEvent = (event: Event): void => {
      if (!landing.armed || !event.isTrusted) return;
      if (landing.onTarget === undefined) {
        landing.onTarget = carriesMark(event);
        landing.path = describe(event);
      }
      if (!landing.onTarget) block(event);
      if (
        event.type === "click" || event.type === "auxclick" ||
        event.type === "contextmenu"
      ) {
        if (landing.onTarget && carriesMark(event)) {
          landing.verdict = "hit";
        } else {
          landing.verdict = "missed";
          landing.path = describe(event);
          block(event);
        }
        // One trusted click ends at its click event, whether that event reached
        // the page or was stopped here.
        landing.armed = false;
      }
    };
    const types = [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "auxclick",
      "contextmenu",
    ];
    const landing: Landing = {
      verdict: "pending",
      onTarget: undefined,
      path: "",
      armed: true,
      detach: () => {
        landing.armed = false;
        for (const type of types) {
          globalThis.removeEventListener(type, onEvent, { capture: true });
        }
      },
    };
    landings[selector] = landing;
    for (const type of types) {
      globalThis.addEventListener(type, onEvent, { capture: true });
    }
  };

  const find = (): HTMLElement | undefined =>
    probe.collect(selector)[0] as HTMLElement | undefined;
  type IdentityState = {
    identities: WeakMap<Element, number>;
    next: number;
  };
  const pageState = globalThis as unknown as Record<string, unknown>;
  let identityState = pageState[identityKey] as IdentityState | undefined;
  if (identityState === undefined) {
    identityState = { identities: new WeakMap(), next: 0 };
    Object.defineProperty(pageState, identityKey, {
      configurable: true,
      value: identityState,
    });
  }
  const identify = (target: Element): number => {
    const known = identityState.identities.get(target);
    if (known !== undefined) return known;
    const created = ++identityState.next;
    identityState.identities.set(target, created);
    return created;
  };
  const remark = remarkSource === null ? null : new Function(
    "return (" + remarkSource + ")",
  )() as (
    probe: ProbeApi,
    ...args: readonly unknown[]
  ) => boolean | Promise<boolean>;

  // One step of page progress, after which the settle looks again.
  //
  // While the document is being rendered that step is a frame, which is what
  // moves a box. A document that is not being rendered produces no frames, so
  // waiting for one waits for something that will not arrive; the step there is
  // one turn of the event loop, delivered through a message channel. It has to
  // be a real turn rather than a resolved promise: a hidden control comes back
  // when a timer or a task puts it back, and a loop that only yields to the
  // microtask queue never lets either run, so it would spin against a control
  // it is itself preventing from returning.
  const nextFrame = (): Promise<void> => {
    diag.frames++;
    return new Promise((resolve) => {
      if (document.visibilityState !== "hidden") {
        requestAnimationFrame(() => resolve());
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    });
  };

  // Absent and hidden are different answers. A hidden control is coming back,
  // so the settle keeps holding for it. A control that has left the document
  // is not coming back — the page rebuilt the surface it was on — so the mark
  // has to be placed again on whatever took its place.
  const measure = ():
    | { x: number; y: number; width: number; height: number }
    | "gone"
    | null => {
    const target = find();
    if (!target) return "gone";
    if (!probe.isRendered(target)) return null;
    const { x, y, width, height } = target.getBoundingClientRect();
    return { x, y, width, height };
  };

  // The area a click can land in, in the same coordinates a bounding rect is
  // reported in. The root element's client box rather than the window, because
  // a classic scrollbar takes columns the window counts and a click cannot
  // reach.
  const pageBox = (): { width: number; height: number } => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  });

  // The point to aim a click at on a control's box: the middle of the part of
  // the box that lies inside the page. A control can reach past the edge of the
  // page, and the middle of the whole box is then further out than the middle
  // of the part inside it, far enough out to be a point the page does not have.
  // The browser accepts a click dispatched there and delivers it to nothing.
  //
  // What the page shows of a control is a wider question than this: an
  // ancestor's overflow can clip it, and anything painted over it can cover it.
  // Neither moves this point.
  const pointOnPage = (
    rect: { x: number; y: number; width: number; height: number },
  ): { x: number; y: number } | null => {
    const page = pageBox();
    const left = Math.max(rect.x, 0);
    const right = Math.min(rect.x + rect.width, page.width);
    const top = Math.max(rect.y, 0);
    const bottom = Math.min(rect.y + rect.height, page.height);
    if (right <= left || bottom <= top) return null;
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  };

  for (;;) {
    if (find() === undefined) {
      if (remark === null) {
        diag.phase = "mark-gone";
        return { missing: true, sawTarget: false };
      }
      diag.phase = "re-marking";
      if (!await remark(probe, ...remarkArgs)) {
        diag.phase = "no-target-to-mark";
        return false;
      }
      if (find() === undefined) {
        diag.phase = "mark-not-placed";
        return false;
      }
    }

    diag.phase = "settling";
    let previous = measure();
    await nextFrame();
    let current = measure();
    while (
      previous === null || current === null ||
      previous === "gone" || current === "gone" ||
      previous.x !== current.x || previous.y !== current.y ||
      previous.width !== current.width || previous.height !== current.height
    ) {
      if (previous === "gone" || current === "gone") break;
      diag.lastBox = JSON.stringify(current);
      previous = current;
      await nextFrame();
      current = measure();
    }
    if (previous === "gone" || current === "gone") {
      // Rebuilt under the settle. Take a frame so a surface rebuilding on
      // every frame cannot spin this, then mark whatever is there now.
      diag.phase = "rebuilt-under-settle";
      await nextFrame();
      continue;
    }
    diag.lastBox = JSON.stringify(current);

    diag.phase = "aiming";
    const target = find();
    if (target === undefined) {
      diag.phase = "rebuilt-before-aim";
      await nextFrame();
      continue;
    }
    // Instant, because the shell sets `scroll-behavior: smooth` and an animated
    // scroll would still be moving the control when the point below is read.
    target.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      // Collapsed between the settle and this measurement. A control with no
      // box is one the settle holds for, so hold for this one too.
      diag.phase = "no-box-before-aim";
      await nextFrame();
      continue;
    }
    const point = pointOnPage(rect);
    if (point === null) {
      return {
        offPage: true,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        page: pageBox(),
      };
    }
    // After the point, so a click that is never dispatched leaves no
    // interceptor on the page.
    arm();
    diag.phase = "aimed";
    return {
      x: point.x,
      y: point.y,
      targetId: identify(target),
    };
  }
};

// Read the marked control's current point in one page turn for a coordinate
// refresh after any interaction observer has finished.
const readMarkedClickPoint = async (
  page: Page,
  selector: string,
  identityKey: string,
): Promise<{ x: number; y: number; targetId: number } | undefined> => {
  return await page.evaluate((targetSelector: string, identityKey: string) => {
    function find(root: Document | ShadowRoot): HTMLElement | undefined {
      for (const element of root.querySelectorAll("*")) {
        if (element.matches(targetSelector)) return element as HTMLElement;
        if (element.shadowRoot) {
          const match = find(element.shadowRoot);
          if (match) return match;
        }
      }
    }

    const target = find(document);
    if (!target) return undefined;
    const identityState = (globalThis as unknown as Record<string, unknown>)[
      identityKey
    ] as {
      identities: WeakMap<Element, number>;
      next: number;
    } | undefined;
    if (identityState === undefined) return undefined;
    let targetId = identityState.identities.get(target);
    if (targetId === undefined) {
      targetId = ++identityState.next;
      identityState.identities.set(target, targetId);
    }
    target.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
    const style = globalThis.getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    if (
      style.display === "none" || style.visibility === "hidden" ||
      rect.width === 0 || rect.height === 0
    ) {
      return undefined;
    }
    // The middle of the part of the box inside the page, the same point the aim
    // answers, so a control that has not moved reads back as unchanged and the
    // click keeps the point it settled on.
    const pageWidth = document.documentElement.clientWidth;
    const pageHeight = document.documentElement.clientHeight;
    const left = Math.max(rect.x, 0);
    const right = Math.min(rect.x + rect.width, pageWidth);
    const top = Math.max(rect.y, 0);
    const bottom = Math.min(rect.y + rect.height, pageHeight);
    if (right <= left || bottom <= top) return undefined;
    return {
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      targetId,
    };
  }, { args: [selector, identityKey] });
};

const clearClickIdentityState = async (
  page: Page,
  identityKey: string,
): Promise<void> => {
  await page.evaluate((key: string) => {
    delete (globalThis as unknown as Record<string, unknown>)[key];
  }, { args: [identityKey] });
};

/**
 * The mark a click aims at, and how to place it again.
 *
 * A caller passes the predicate it used to mark its target, so a control that
 * the page rebuilds between the mark and the click can be marked again and
 * clicked, rather than reported as vanished. The predicate is the same one the
 * caller ran to place the mark, so re-marking applies the caller's own
 * readiness rules — including its settle — to whatever control took over.
 */
export interface ClickMark {
  token: string;
  remark?: {
    predicate: (
      probe: ProbeApi,
      // deno-lint-ignore no-explicit-any
      ...args: any[]
    ) => boolean | Promise<boolean>;
    args: readonly unknown[];
  };
}

/**
 * Click the element whose click marks contain the token, then clear that mark.
 * Shared by `clickCfButton`, `clickNthCfButton`, `clickTrustedAction`, and the
 * text-matching click helpers in `note-button-helpers.ts`: each one marks its
 * target through its own predicate, and the aim/click/untag tail is the same
 * for all of them.
 *
 * One wait settles the control and measures where to click it. The point is
 * measured again in one page turn immediately before the trusted click, after
 * any interaction observer has finished. A moved or missing target goes
 * through the same settle and replacement handling before dispatch.
 *
 * That last measurement still crosses the protocol before the mouse events do,
 * and the page keeps running while it does, so a surface that relays out in
 * that crossing carries the control off the point the click is aimed at. The
 * aim leaves an interceptor watching for the interaction it armed for: one that
 * does not reach the marked control is stopped at the window, so the control
 * was not activated and it can be aimed at and clicked again where it now
 * stands. The loop ends on the first click the control receives, so the control
 * is activated exactly once.
 *
 * Clicking again requires a pixel no dispatch has lost yet. A control that has
 * not moved is dispatched at the same pixel, and a page that shuffles a control
 * around a few positions comes back to one of them, so both stop at the second
 * dispatch that repeats itself rather than dispatching forever. What is
 * reported then names every pixel tried and what the click reached at each.
 */
export async function clickMarked(
  page: Page,
  mark: string | ClickMark,
): Promise<void> {
  const { token, remark } = typeof mark === "string" ? { token: mark } : mark;
  const markSelector = `[${CLICK_TARGET_ATTR}~="${token}"]`;
  const identityKey = `__commonToolsClickIdentity_${crypto.randomUUID()}`;
  // Pixels a dispatch has already lost this click at, and what it reached
  // there.
  const lost = new Map<string, string>();
  try {
    await openClickLanding(page, markSelector);
    const measureAim = async (): Promise<{
      x: number;
      y: number;
      targetId: number;
    }> => {
      let aim: ClickAim | undefined;
      try {
        aim = await waitForCondition(page, aimAtMarkedTarget, {
          args: [
            markSelector,
            remark ? remark.predicate.toString() : null,
            remark ? remark.args : [],
            identityKey,
          ],
        });
      } catch (cause) {
        const probe = await readTextProbe(page, markSelector).catch(() =>
          undefined
        );
        const progress = await readAimProgress(page, markSelector).catch(() =>
          undefined
        );
        throw new Error(
          `Marked click target ${markSelector} never presented a stable box. ` +
            `Aim reached: ${toIndentedDebugString(progress)}. ` +
            `Last probe: ${toIndentedDebugString(probe)}`,
          { cause },
        );
      }
      if (aim !== undefined && "offPage" in aim) {
        const probe = await readTextProbe(page, markSelector).catch(() =>
          undefined
        );
        throw new Error(
          `The control marked for click lies outside the page, so there is ` +
            `no point on it a click can reach. Its box is ` +
            `${toIndentedDebugString(aim.box)} and the page is ` +
            `${toIndentedDebugString(aim.page)}. ` +
            `Last probe: ${toIndentedDebugString(probe)}`,
        );
      }
      if (aim === undefined || "missing" in aim) {
        const probe = await readTextProbe(page, markSelector).catch(() =>
          undefined
        );
        throw new Error(
          `The control marked for click was replaced before the click ` +
            `could be aimed at it${
              aim?.sawTarget ? " while its box was settling" : ""
            }. Last probe: ${toIndentedDebugString(probe)}`,
        );
      }
      return aim;
    };

    for (;;) {
      const aim = await measureAim();
      // Where the mouse events actually went. The refresh below runs after this
      // point was chosen and can move it, and what the interceptor reports on
      // is whatever was dispatched last.
      let dispatched = { x: aim.x, y: aim.y };
      await page.clickPoint({ x: aim.x, y: aim.y }, {
        refreshPoint: async () => {
          const current = await readMarkedClickPoint(
            page,
            markSelector,
            identityKey,
          );
          if (
            current?.targetId === aim.targetId && current.x === aim.x &&
            current.y === aim.y
          ) {
            return dispatched;
          }
          if (remark) {
            await clearClickMark(page, token);
            await waitForCondition(page, remark.predicate, {
              args: [...remark.args],
            });
          }
          const settled = await measureAim();
          dispatched = { x: settled.x, y: settled.y };
          return dispatched;
        },
      });
      const landing = await readClickLanding(page, markSelector);
      if (landing.verdict === "hit") return;
      // The click did not reach the control, so the control did not act on it.
      const pixel = `${Math.round(dispatched.x)},${Math.round(dispatched.y)}`;
      const reached = landing.verdict === "missed"
        ? `the click reached ${landing.path || "nothing"}`
        : `no click was raised; the interaction reached ${
          landing.path || "nothing"
        }`;
      const lostBefore = lost.get(pixel);
      if (lostBefore !== undefined) {
        const progress = await readAimProgress(page, markSelector).catch(() =>
          undefined
        );
        const probe = await readTextProbe(page, markSelector).catch(() =>
          undefined
        );
        throw new Error(
          `${markSelector} is aimed at ${pixel} again, where a trusted click ` +
            `already failed to reach it (${lostBefore}). Every pixel tried: ${
              toIndentedDebugString(Object.fromEntries(lost))
            }. Aim reached: ${toIndentedDebugString(progress)}. ` +
            `Last probe: ${toIndentedDebugString(probe)}`,
        );
      }
      lost.set(pixel, reached);
      // Aim again: the page has had the whole dispatch to move the control, and
      // the next aim finds where it went.
    }
  } finally {
    await closeClickLanding(page, markSelector).catch(() => {});
    await Promise.all([
      clearClickMark(page, token).catch(() => {}),
      clearClickIdentityState(page, identityKey).catch(() => {}),
    ]);
  }
}

export async function clickCfButtonAndWaitForText(
  page: Page,
  buttonSelector: string,
  textSelector: string,
  text: string,
) {
  let textProbe: TextProbe | undefined;

  // Fast path: the effect may already be present (idempotent re-entry).
  if (await textIsPresent(page, textSelector, text)) {
    return;
  }

  // clickCfButton settles the view before and after delivering one click to the
  // bound handler.
  try {
    await clickCfButton(page, buttonSelector);
  } catch (cause) {
    textProbe = await readTextProbe(page, textSelector).catch(() => undefined);
    throw new Error(
      `Failed to click "${buttonSelector}" while waiting for "${textSelector}" to contain "${text}". Last probe: ${
        toIndentedDebugString(textProbe)
      }`,
      { cause },
    );
  }

  // The click is delivered; wait for its effect, resolving the instant the text
  // appears while driving the settle that applies it. An effect that renders a
  // few cycles after the click — including an optimistic perUser/perSpace write
  // whose chip trails the commit — is captured without ever re-clicking.
  try {
    await waitForTextWhileSettling(page, textSelector, text);
  } catch (cause) {
    textProbe = await readTextProbe(page, textSelector).catch(() => undefined);
    throw new Error(
      `Timed out clicking "${buttonSelector}" until "${textSelector}" contained "${text}". Last probe: ${
        toIndentedDebugString(textProbe)
      }`,
      { cause },
    );
  }
}

export async function waitForRuntimeSynced(
  page: Page,
) {
  // Quiescence isn't a per-space question: allSynced awaits every space the
  // worker has opened.
  await waitForCondition(page, runtimeSynced);
}

export type SchedulerLoadSummary = {
  /** Scheduler-state rehydration health on (re)load. */
  rehydration: {
    ok: number;
    missNoSnapshot: number;
    missActionId: number;
    missFingerprint: number;
    skipShouldNotApply: number;
    fallbackRunNoMatch: number;
    fallbackRunTimeout: number;
  };
  graph: {
    nodes: number;
    edges: number;
    computations: number;
    effects: number;
    inputs: number;
    inactive: number;
    actionsWithStats: number;
    actionRuns: number;
    actionRunsThroughActionBody: number;
    actionRunsFromStats: number;
    actionTotalTimeFromStats: number;
    computationRunsFromStats: number;
    computationTotalTimeFromStats: number;
    effectRunsFromStats: number;
    effectTotalTimeFromStats: number;
  };
  topSchedulerTiming: Array<{
    key: string;
    count: number;
    totalTime: number;
    average: number;
    p50: number;
    p95: number;
    max: number;
  }>;
  topActions: Array<{
    actionId: string;
    actionType: "effect" | "computation";
    runCount: number;
    totalTime: number;
    averageTime: number;
  }>;
};

export async function collectSchedulerLoadSummary(
  page: Page,
): Promise<SchedulerLoadSummary | null> {
  return await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: {
        rt?: {
          getLoggerCounts?: () => Promise<{
            timing: Record<string, Record<string, TimingRow>>;
            counts?: Record<
              string,
              Record<string, { debug?: number } | number>
            >;
          }>;
          getGraphSnapshot?: () => Promise<{
            nodes: GraphNode[];
            edges: unknown[];
          }>;
          idle?: () => Promise<void>;
        };
      };
    }).commonfabric?.rt;
    if (!rt?.getLoggerCounts || !rt?.getGraphSnapshot || !rt?.idle) {
      return null;
    }
    await rt.idle();

    const { timing, counts } = await rt.getLoggerCounts();
    const graph = await rt.getGraphSnapshot();
    const schedulerTiming = timing["scheduler"] ?? {};

    // Scheduler-state rehydration health on (re)load: how many actions restored
    // from a persisted observation vs re-ran, and why the misses missed.
    const schedulerCounts = counts?.["scheduler"] ?? {};
    const countKey = (key: string): number => {
      const v = schedulerCounts[key] as { debug?: number } | number | undefined;
      return typeof v === "number" ? v : (v?.debug ?? 0);
    };
    const rehydration = {
      ok: countKey("rehydrate/ok"),
      missNoSnapshot: countKey("rehydrate/miss/no-snapshot"),
      missActionId: countKey("rehydrate/miss/action-id"),
      missFingerprint: countKey("rehydrate/miss/fingerprint"),
      skipShouldNotApply: countKey("rehydrate/skip/should-not-apply"),
      fallbackRunNoMatch: countKey("rehydrate/fallback-run/no-match"),
      fallbackRunTimeout: countKey("rehydrate/fallback-run/timeout"),
    };
    const schedulerRunCount = schedulerTiming["scheduler/run"]?.count ?? 0;
    const schedulerRunActionCount =
      schedulerTiming["scheduler/run/action"]?.count ?? 0;

    const typedNodes = graph.nodes;
    const actionNodes = typedNodes.filter((node) =>
      (node.type === "effect" || node.type === "computation") && node.stats
    );
    const byActionId = new Map<string, {
      actionId: string;
      actionType: "effect" | "computation";
      runCount: number;
      totalTime: number;
      averageTime: number;
    }>();

    for (const node of actionNodes) {
      const stats = node.stats;
      if (!stats) continue;
      const actionType = node.type === "effect" ? "effect" : "computation";
      const existing = byActionId.get(node.id);
      if (!existing || stats.runCount > existing.runCount) {
        byActionId.set(node.id, {
          actionId: node.id,
          actionType,
          runCount: stats.runCount,
          totalTime: stats.totalTime,
          averageTime: stats.averageTime,
        });
      }
    }

    const actionRows = [...byActionId.values()];
    const computationRows = actionRows.filter((row) =>
      row.actionType === "computation"
    );
    const effectRows = actionRows.filter((row) => row.actionType === "effect");
    const round = (value: number) => Number(value.toFixed(3));

    return {
      rehydration,
      graph: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        computations: typedNodes.filter((node) =>
          node.type === "computation"
        ).length,
        effects: typedNodes.filter((node) => node.type === "effect").length,
        inputs: typedNodes.filter((node) => node.type === "input").length,
        inactive: typedNodes.filter((node) => node.type === "inactive").length,
        actionsWithStats: actionNodes.length,
        actionRuns: schedulerRunCount,
        actionRunsThroughActionBody: schedulerRunActionCount,
        actionRunsFromStats: actionRows.reduce(
          (sum, row) => sum + row.runCount,
          0,
        ),
        actionTotalTimeFromStats: round(
          actionRows.reduce((sum, row) => sum + row.totalTime, 0),
        ),
        computationRunsFromStats: computationRows.reduce(
          (sum, row) => sum + row.runCount,
          0,
        ),
        computationTotalTimeFromStats: round(
          computationRows.reduce((sum, row) => sum + row.totalTime, 0),
        ),
        effectRunsFromStats: effectRows.reduce(
          (sum, row) => sum + row.runCount,
          0,
        ),
        effectTotalTimeFromStats: round(
          effectRows.reduce((sum, row) => sum + row.totalTime, 0),
        ),
      },
      topSchedulerTiming: Object.entries(schedulerTiming)
        .sort((a, b) => (b[1].totalTime ?? 0) - (a[1].totalTime ?? 0))
        .slice(0, 16)
        .map(([key, value]) => ({
          key,
          count: value.count ?? 0,
          totalTime: round(value.totalTime ?? 0),
          average: round(value.average ?? 0),
          p50: round(value.p50 ?? 0),
          p95: round(value.p95 ?? 0),
          max: round(value.max ?? 0),
        })),
      topActions: actionRows
        .sort((a, b) =>
          b.runCount - a.runCount ||
          b.totalTime - a.totalTime ||
          a.actionId.localeCompare(b.actionId)
        )
        .slice(0, 20)
        .map((row) => ({
          actionId: row.actionId,
          actionType: row.actionType,
          runCount: row.runCount,
          totalTime: round(row.totalTime),
          averageTime: round(row.averageTime),
        })),
    };
  });
}

type TimingRow = {
  count: number;
  totalTime: number;
  average: number;
  p50: number;
  p95: number;
  max: number;
};

/**
 * One timing-stats row distilled from a logger's `timeStats` (ms). Used to
 * surface where wall-clock goes under multi-browser contention — chiefly the
 * main-thread `runtime-client` IPC round-trips, which are what stretch when
 * the worker can't keep up.
 */
export interface TimingStatRow {
  key: string;
  count: number;
  average: number;
  p50: number;
  p95: number;
  max: number;
  total: number;
}

/**
 * Counters that quantify how much the worker re-ran and how often writes lost a
 * conflict, read back from `getLoggerCounts().counts`. Conflicts that ratchet
 * (a non-falling, bounded count) rather than storm is the healthy steady state:
 * a stale-seq write is rejected, the optimistic value is dropped, the
 * computation re-runs once against confirmed state, and settles.
 */
export interface ChurnCounters {
  /** Total computation/effect runs (`scheduler/run/action`). */
  actionRuns: number;

  /** Commit conflicts — stale-seq-basis rejections (`storage.v2/commit-conflict`). */
  commitConflicts: number;

  /** Reverts emitted after a rejected commit (`storage.v2/commit-revert`). */
  commitReverts: number;

  /** Non-conflict commit rejections (`storage.v2/commit-rejected`). */
  commitRejected: number;

  /** Reactive-action commit errors that triggered a retry (`scheduler/schedule-run-error`). */
  scheduleRunErrors: number;

  /** Event handlers that lost the receipt race permanently (`scheduler/event-lost-race`). */
  eventLostRaces: number;

  /** Server-execution v2 stage C tuning T2 (flag-ON clients only, else 0):
   * event-handler echoes dropped at seal because their intent was already
   * terminal (`speculation-overlay/late-echo-dropped`) — the late-echo
   * class the two-browsers lockdown stall belonged to. */
  overlayLateEchoDrops: number;

  /** Stage C tuning T2: overlay sweeps the replica's arrival wake ran
   * (`speculation-overlay/arrival-sweep`) — served values arriving
   * decoupled from a watermark advance. */
  overlayArrivalSweeps: number;

  /** Stage C design (e): intent checks the overlay's storage-notification
   * listener ran (`speculation-overlay/intent-check`) — one per fire plus
   * one per coalesced sidecar change while intents are outstanding; never
   * a scheduler run. */
  overlayIntentChecks: number;

  /** Stage C design (e): intents resolved by their tracked entry's own
   * consequence mark (`speculation-overlay/intent-retired-by-consequence-of`)
   * — the sanctioned `consequenceOf` carrier. */
  overlayIntentsByConsequenceOf: number;

  /** Stage C design (e): intent-origin echoes retired by the watermark
   * BACKSTOP instead (`speculation-overlay/intent-echo-retired-by-backstop`). */
  overlayIntentEchoBackstops: number;

  /** Stage C W2.1: client CASCADE-child echoes retired because an ancestor
   * intent's terminal consequence arrived (`speculation-overlay/
   * cascade-echo-retired`) — the W0 l3 "duplicate join" class: the join is
   * the click handler's cascade child, its echo carries a client-minted id
   * no mark ever names and writes an entity doc the server never writes. */
  overlayCascadeEchoRetired: number;

  /** Stage C W2.1: the subset retired on a consequenced parent's mark
   * while NO doc the echo wrote held a confirmed value at or after the
   * MARK frame's seq (`speculation-overlay/cascade-echo-retired-
   * unarrived`) — the FLICKER witness: the server's cascade child had
   * not landed at this client when its echo went (the
   * purged-LT1-leftover shape, W3's α1: drained a wave after the
   * parent's consequence). Keyed on the MARK's frame, not the echo's
   * read basis (a concurrent writer moves a doc past the basis without
   * the child having landed). A HEURISTIC — the shape-(b) decision
   * instrument, so read the biases (combined review 2026-08-19, F4/F5):
   * it UNDER-counts the coalesced-purged shape (a foreign write to a
   * written doc landing in the mark's own frame reads "arrived" — e.g.
   * both voters marking in ONE commit that carries the OTHER voter's
   * add while THIS voter's child was purged), and OVER-counts on the
   * equality cutoff (an unchanged authoritative value moves no seq and
   * reads "unarrived"). Treat a nonzero reading as real flicker
   * evidence and a zero as NOT proof of none. */
  overlayCascadeEchoFlickers: number;
}

export interface BrowserLoadSummary {
  label: string;

  /**
   * Main-thread `runtime-client` IPC wait timing, including terminal failures.
   * Long waits can reflect worker computation or downstream storage and server
   * waits; worker and server profiles distinguish those causes.
   */
  ipc: TimingStatRow[];

  /** Every non-success terminal outcome, without ranking or truncation. */
  ipcFailures: TimingStatRow[];

  /** Whether worker statistics could be collected for this snapshot. */
  workerStatus: "collected" | "skipped" | "unavailable";

  /**
   * Requests still in flight on the main thread when the summary was taken
   * ({ type, ageMs }). The completed-timing rows above cannot show a request
   * that never came back; this names it.
   */
  pendingIpc: Array<{ type: string; ageMs: number }>;

  /**
   * Worker-side request ledger (`runtime-worker.ipc` counts): how many
   * requests of each type the worker received and answered. A main-side
   * pending request that is missing here was never delivered (starved event
   * loop); received-but-unanswered means the handler never returned; present
   * in both means the response was lost in transit.
   */
  workerIpc: Record<string, number>;

  /** Worker-side scheduler/runner/storage timing — where the work happens. */
  worker: TimingStatRow[];

  /** Conflict / re-run counters — see {@link ChurnCounters}. */
  churn: ChurnCounters;

  /**
   * Send/settle timeline of the first IPC requests (the boot window), offsets
   * in ms from the runtime connection's construction. The aggregate rows say a
   * request was slow; this says WHEN it ran and what overlapped it — e.g. a
   * pattern:getSpaceRoot spanning the whole boot vs one that queued behind it.
   */
  requestTimeline: Array<{
    type: string;
    sentAtMs: number;
    doneAtMs?: number;
    error?: boolean;
    outcome?: RequestOutcome;
  }>;
}

/**
 * How long the worker is given to answer the request for its statistics,
 * unless a caller names its own budget.
 *
 * Reading them is itself a request, and a request carries no deadline of its
 * own, so a worker that has stopped answering would hold a collection open
 * for as long as the page lived. The cost of the budget is that a worker
 * which was slow rather than stopped loses the statistics it was about to
 * return: nothing reported is wrong, but the worker half can be missing from
 * a summary that could have carried it. A collection that always returns is
 * worth that, since the summary exists to explain a run that is already in
 * trouble.
 *
 * The size guards against that loss rather than against a long wait. Reading
 * the counters costs the worker almost nothing, so a slow answer means a busy
 * worker, and the runs that most need a summary are the loaded ones where a
 * worker stays busy longest. A budget of seconds would fire on those; this one
 * is set where only a worker that has stopped reaches it, and a wedged worker
 * still costs far less than the step it runs in.
 */
const WORKER_STATS_BUDGET_MS = 30_000;

/**
 * Collect aggregate timing stats from one browser: main-thread IPC waits
 * (`commonfabric.getTimingStatsBreakdown()`) plus the worker's
 * scheduler/runner/storage timing (`commonfabric.rt.getLoggerCounts()`).
 * Worker collection is skipped when `includeWorker` is false, and abandoned
 * when the worker does not answer within `workerBudgetMs`, so failure
 * diagnostics are readable from a page whose worker is stalled. A worker that
 * answers later than the budget loses its statistics. Missing worker
 * statistics are identified by `workerStatus`.
 */
export async function collectBrowserLoadSummary(
  page: Page,
  label: string,
  options: { includeWorker?: boolean; workerBudgetMs?: number } = {},
): Promise<BrowserLoadSummary> {
  const workerBudget = (options.includeWorker ?? true)
    ? options.workerBudgetMs ?? WORKER_STATS_BUDGET_MS
    : 0;
  const collected = await page.evaluate(async (workerBudgetMs: number) => {
    type Stats = {
      count?: number;
      average?: number;
      p50?: number;
      p95?: number;
      max?: number;
      totalTime?: number;
    };
    const round = (value: number | undefined): number =>
      Number((value ?? 0).toFixed(2));
    const toRows = (
      group: Record<string, Stats> | undefined,
      limit: number,
    ) =>
      Object.entries(group ?? {})
        .map(([key, stats]) => ({
          key,
          count: stats.count ?? 0,
          average: round(stats.average),
          p50: round(stats.p50),
          p95: round(stats.p95),
          max: round(stats.max),
          total: round(stats.totalTime),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, limit);

    type CountEntry = { total?: number } | number | undefined;
    const cf = (globalThis as typeof globalThis & {
      commonfabric?: {
        getTimingStatsBreakdown?: () => Record<string, Record<string, Stats>>;
        rt?: {
          getLoggerCounts?: () => Promise<{
            timing?: Record<string, Record<string, Stats>>;
            counts?: Record<string, Record<string, CountEntry>>;
          }>;
          getPendingRequests?: () => Array<
            { msgId: number; type: string; ageMs: number }
          >;
          getRequestTimeline?: () => Array<{
            msgId: number;
            type: string;
            sentAtMs: number;
            doneAtMs?: number;
            error?: boolean;
            outcome?: RequestOutcome;
          }>;
        };
      };
    }).commonfabric;

    const collectMain = () => {
      const timing = cf?.getTimingStatsBreakdown?.()["runtime-client"] ?? {};
      const rows = toRows(timing, Infinity);
      return {
        ipc: rows.filter((row) => !row.key.startsWith("ipc-outcome/"))
          .slice(0, 14),
        ipcFailures: rows.filter((row) =>
          row.key.startsWith("ipc-outcome/") &&
          !row.key.startsWith("ipc-outcome/success/")
        ),
        pendingIpc: (cf?.rt?.getPendingRequests?.() ?? [])
          .map(({ type, ageMs }) => ({ type, ageMs })),
        requestTimeline: (cf?.rt?.getRequestTimeline?.() ?? [])
          .map(({ type, sentAtMs, doneAtMs, error, outcome }) => ({
            type,
            sentAtMs,
            ...(doneAtMs !== undefined ? { doneAtMs } : {}),
            ...(error ? { error } : {}),
            ...(outcome !== undefined ? { outcome } : {}),
          })),
      };
    };
    // A budget of zero is a caller that does not want the worker asked at
    // all, which is the same as spending no time on it.
    const skipWorker = workerBudgetMs === 0;
    let workerStatus: "collected" | "skipped" | "unavailable" = skipWorker
      ? "skipped"
      : "unavailable";

    let worker: ReturnType<typeof toRows> = [];
    let workerIpc: Record<string, number> = {};
    const churn = {
      actionRuns: 0,
      commitConflicts: 0,
      commitReverts: 0,
      commitRejected: 0,
      scheduleRunErrors: 0,
      eventLostRaces: 0,
      overlayLateEchoDrops: 0,
      overlayArrivalSweeps: 0,
      overlayIntentChecks: 0,
      overlayIntentsByConsequenceOf: 0,
      overlayIntentEchoBackstops: 0,
      overlayCascadeEchoRetired: 0,
      overlayCascadeEchoFlickers: 0,
    };
    try {
      const workerCounts = skipWorker ? undefined : await Promise.race([
        cf?.rt?.getLoggerCounts?.(),
        new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), workerBudgetMs);
        }),
      ]);
      if (workerCounts !== undefined) workerStatus = "collected";
      const workerTiming = workerCounts?.timing ?? {};
      // Prefix-match so sub-loggers are included: storage commit/conflict
      // timings live under `storage.v2` (+ `.transaction`/`.multi-space-commit`),
      // not a bare `storage` logger; runner/scheduler similarly have sub-loggers.
      // `piece` carries the PiecesController phase timers (boot,
      // default-pattern ensure/resume); `runner.ipc`/`runner.loop` (worker
      // request delivery/handling + event-loop lag) ride the `runner` prefix;
      // `pattern-manager` carries the compile-cache read/evaluate spans that
      // dominate a storage-resume boot; `js-compiler` the per-file
      // program-build/type-check/emit spans that decompose a cold compile.
      const prefixes = [
        "scheduler",
        "runner",
        "storage",
        "piece",
        "pattern-manager",
        "js-compiler",
      ];
      const includeLogger = (name: string): boolean =>
        name === "runtime-client.cfc-label" ||
        prefixes.some((prefix) =>
          name === prefix || name.startsWith(`${prefix}.`)
        );
      const selected: Record<string, Stats> = {};
      for (const [name, groupStats] of Object.entries(workerTiming)) {
        if (!includeLogger(name)) continue;
        for (const [key, stats] of Object.entries(groupStats)) {
          selected[`${name}/${key}`] = stats;
        }
      }
      worker = toRows(selected, 28);

      const counts: Record<string, Record<string, CountEntry>> =
        workerCounts?.counts ?? {};
      const countOf = (logger: string, key: string): number => {
        const entry = counts[logger]?.[key];
        return typeof entry === "number" ? entry : entry?.total ?? 0;
      };
      workerIpc = Object.fromEntries(
        Object.keys(counts["runtime-worker.ipc"] ?? {}).sort().map((
          key,
        ) => [key, countOf("runtime-worker.ipc", key)]),
      );
      churn.actionRuns = countOf("scheduler", "schedule-run-start");
      churn.commitConflicts = countOf("storage.v2", "commit-conflict");
      churn.commitReverts = countOf("storage.v2", "commit-revert");
      churn.commitRejected = countOf("storage.v2", "commit-rejected");
      churn.scheduleRunErrors = countOf("scheduler", "schedule-run-error");
      churn.eventLostRaces = countOf("scheduler", "event-lost-race");
      churn.overlayLateEchoDrops = countOf(
        "speculation-overlay",
        "late-echo-dropped",
      );
      churn.overlayArrivalSweeps = countOf(
        "speculation-overlay",
        "arrival-sweep",
      );
      churn.overlayIntentChecks = countOf(
        "speculation-overlay",
        "intent-check",
      );
      churn.overlayIntentsByConsequenceOf = countOf(
        "speculation-overlay",
        "intent-retired-by-consequence-of",
      );
      churn.overlayIntentEchoBackstops = countOf(
        "speculation-overlay",
        "intent-echo-retired-by-backstop",
      );
      churn.overlayCascadeEchoRetired = countOf(
        "speculation-overlay",
        "cascade-echo-retired",
      );
      churn.overlayCascadeEchoFlickers = countOf(
        "speculation-overlay",
        "cascade-echo-retired-unarrived",
      );
    } catch {
      // Worker may be disposed during teardown — main-thread IPC still tells
      // the contention story.
    }

    return { ...collectMain(), workerIpc, worker, churn, workerStatus };
  }, { args: [workerBudget] });
  return {
    label,
    ipc: collected.ipc,
    ipcFailures: collected.ipcFailures,
    workerStatus: collected.workerStatus,
    pendingIpc: collected.pendingIpc,
    workerIpc: collected.workerIpc,
    worker: collected.worker,
    churn: collected.churn,
    requestTimeline: collected.requestTimeline,
  };
}

/**
 * Times labeled async steps so a run can report where its wall-clock went.
 * `run` records the elapsed ms even when the wrapped step throws, so a timed-
 * out propagation wait still shows up in the summary.
 */
// ---------------------------------------------------------------------------
// Sender-echo probe (stage-C W4's build item; W2 flag 3): client-local
// speculation latency — from the sender's own trusted click to the sender's
// OWN speculative render of the value it authored (the overlay echo). The
// arrival series times send-click → the OTHER browser's render; nothing
// measured the preserved property that the sender's local echo stays in the
// low-millisecond class. Both timestamps are taken on the SAME page's
// `performance.now()` clock — the click at a capture-phase listener when the
// trusted click event is dispatched in the page, the render inside a
// MutationObserver callback when the armed text is first present in the
// armed selector's deep text — so no CDP round-trip skews the difference.
//
// Measurement-only: installed by the opt-in benchmark legs, never by the
// ordinary gate steps, and it touches no production code. The DOM-arrival
// definition of "render" matches the arrival series' (`waitForText` reads
// the DOM), so the two numbers are comparable side by side.
//
// The probe keeps its own observer set (document + every open shadow root,
// present and future via an `attachShadow` chain-wrap — the same coverage
// rule as `waitForCondition`'s pulse hub in packages/integration/utils.ts,
// replicated privately so a probe bug can never perturb the harness's own
// wait machinery). The per-mutation check short-circuits unless an armed,
// clicked, unsampled expectation exists, so the probe's steady-state cost is
// one no-op callback per mutation batch.

/** One sampled click→own-render echo. All times are page-clock ms. */
export type SenderEchoSample = {
  label: string;
  text: string;

  /** performance.now() of the last trusted click seen while armed. */
  clickMs: number;

  /** performance.now() when the armed text was first observed in the DOM. */
  renderMs: number;

  /** renderMs − clickMs: the sender-side speculative echo latency. */
  echoMs: number;

  /** Trusted clicks observed while armed (a re-aimed click re-stamps). */
  clicks: number;
};

/** An armed expectation that produced no sample, and why — reported, never
 * silently dropped. `pre-armed`: the text was already rendered at arm time
 * (the sample would not measure the click). `unclicked` / `unrendered`: a
 * later arm or the final read found it still waiting. */
export type SenderEchoAbandoned = {
  label: string;
  text: string;
  reason: "pre-armed" | "unclicked" | "unrendered";
};

export type SenderEchoReport = {
  samples: SenderEchoSample[];
  abandoned: SenderEchoAbandoned[];
};

type SenderEchoPageState = {
  pending?: {
    label: string;
    text: string;
    selector: string;
    armedMs: number;
    clickMs?: number;
    clicks: number;
  };
  samples: SenderEchoSample[];
  abandoned: SenderEchoAbandoned[];
};

type SenderEchoGlobal = typeof globalThis & {
  __cfcSenderEcho?: SenderEchoPageState & { check: () => void };
};

/** Install the echo probe on `page`. Idempotent. Must run before
 * {@link armSenderEcho}; install it once the page is logged in and rendered
 * so the open shadow roots exist to be scanned. */
export async function installSenderEchoProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as SenderEchoGlobal;
    if (g.__cfcSenderEcho) return;

    // Shadow-piercing collect + text, self-contained (the probe cannot
    // close over module code). `textContent` (not innerText) keeps the
    // per-mutation check layout-free; visibility subtleties do not apply
    // to the rendered-transcript / tally elements this measures.
    const collect = (selector: string): Element[] => {
      const out: Element[] = [];
      const walk = (root: Document | ShadowRoot) => {
        out.push(...root.querySelectorAll(selector));
        for (const el of root.querySelectorAll("*")) {
          const sr = (el as HTMLElement).shadowRoot;
          if (sr) walk(sr);
        }
      };
      walk(document);
      return out;
    };
    const deepText = (element: Element): string => {
      const parts: string[] = [element.textContent ?? ""];
      const walk = (root: Element | ShadowRoot) => {
        for (const el of root.querySelectorAll("*")) {
          const sr = (el as HTMLElement).shadowRoot;
          if (sr) {
            parts.push(sr.textContent ?? "");
            walk(sr);
          }
        }
      };
      const own = (element as HTMLElement).shadowRoot;
      if (own) {
        parts.push(own.textContent ?? "");
        walk(own);
      }
      walk(element);
      return parts.join(" ");
    };

    const check = () => {
      const state = g.__cfcSenderEcho;
      const pending = state?.pending;
      if (!state || !pending || pending.clickMs === undefined) return;
      const found = collect(pending.selector).some((el) =>
        deepText(el).includes(pending.text)
      );
      if (!found) return;
      const renderMs = performance.now();
      state.samples.push({
        label: pending.label,
        text: pending.text,
        clickMs: pending.clickMs,
        renderMs,
        echoMs: renderMs - pending.clickMs,
        clicks: pending.clicks,
      });
      state.pending = undefined;
    };

    // Private observer set: document + every open shadow root, present and
    // future. Chain-wraps attachShadow (the pulse hub's wrap, if installed,
    // composes with this one — both fire).
    const observed = new WeakSet<Document | ShadowRoot>();
    const retained: MutationObserver[] = [];
    const observe = (root: Document | ShadowRoot) => {
      if (observed.has(root)) return;
      observed.add(root);
      const mo = new MutationObserver(check);
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
    scan(document);
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
      return root;
    };

    // The click stamp: capture phase, trusted events only (the harness's
    // CDP click is trusted; synthetic dispatches are not). A re-dispatched
    // click while still pending re-stamps — the earlier one missed the
    // control, so the last click is the one whose echo renders.
    globalThis.addEventListener("click", (event) => {
      const pending = g.__cfcSenderEcho?.pending;
      if (!pending || !(event as MouseEvent).isTrusted) return;
      pending.clickMs = performance.now();
      pending.clicks += 1;
    }, true);

    g.__cfcSenderEcho = { samples: [], abandoned: [], check };
  });
}

/** Arm one expectation: the next trusted click on `page` starts the clock,
 * and `text` first appearing in `selector`'s deep text stops it. Call after
 * the draft is filled and immediately before the click. An expectation whose
 * text is already rendered is recorded `pre-armed` and NOT armed; a previous
 * expectation still pending is recorded abandoned. */
export async function armSenderEcho(
  page: Page,
  label: string,
  selector: string,
  text: string,
): Promise<void> {
  await page.evaluate(
    (label: string, selector: string, text: string) => {
      const g = globalThis as SenderEchoGlobal;
      const state = g.__cfcSenderEcho;
      if (!state) {
        throw new Error(
          "senderEcho: probe not installed (call installSenderEchoProbe first)",
        );
      }
      const prior = state.pending;
      if (prior) {
        state.abandoned.push({
          label: prior.label,
          text: prior.text,
          reason: prior.clickMs === undefined ? "unclicked" : "unrendered",
        });
        state.pending = undefined;
      }
      // Pre-check with the same deep-text rule the check uses: arm only if
      // the text is not already rendered.
      const collect = (selector: string): Element[] => {
        const out: Element[] = [];
        const walk = (root: Document | ShadowRoot) => {
          out.push(...root.querySelectorAll(selector));
          for (const el of root.querySelectorAll("*")) {
            const sr = (el as HTMLElement).shadowRoot;
            if (sr) walk(sr);
          }
        };
        walk(document);
        return out;
      };
      const deepText = (element: Element): string => {
        const parts: string[] = [element.textContent ?? ""];
        const walk = (root: Element | ShadowRoot) => {
          for (const el of root.querySelectorAll("*")) {
            const sr = (el as HTMLElement).shadowRoot;
            if (sr) {
              parts.push(sr.textContent ?? "");
              walk(sr);
            }
          }
        };
        const own = (element as HTMLElement).shadowRoot;
        if (own) {
          parts.push(own.textContent ?? "");
          walk(own);
        }
        walk(element);
        return parts.join(" ");
      };
      if (collect(selector).some((el) => deepText(el).includes(text))) {
        state.abandoned.push({ label, text, reason: "pre-armed" });
        return;
      }
      state.pending = {
        label,
        text,
        selector,
        armedMs: performance.now(),
        clicks: 0,
      };
    },
    { args: [label, selector, text] },
  );
}

/** Read the probe's samples and abandoned rows. A still-pending expectation
 * is flushed into `abandoned` (the read is the series' end). */
export async function readSenderEchoReport(
  page: Page,
): Promise<SenderEchoReport> {
  return await page.evaluate(() => {
    const g = globalThis as SenderEchoGlobal;
    const state = g.__cfcSenderEcho;
    if (!state) return { samples: [], abandoned: [] };
    const prior = state.pending;
    if (prior) {
      state.abandoned.push({
        label: prior.label,
        text: prior.text,
        reason: prior.clickMs === undefined ? "unclicked" : "unrendered",
      });
      state.pending = undefined;
    }
    return { samples: state.samples, abandoned: state.abandoned };
  }) as SenderEchoReport;
}

/** One summary line + the per-event series, in the benchmark logs' style
 * (`[sender-echo] …`; quantiles as the chat series computes them:
 * sorted[floor(f·n)] clamped, so p95 at n=20 is the max). */
export function logSenderEchoSummary(
  context: string,
  arm: string,
  report: SenderEchoReport,
): void {
  const sorted = report.samples.map((s) => s.echoMs).sort((a, b) => a - b);
  const q = (f: number) =>
    sorted.length === 0
      ? undefined
      : sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const fmt = (v: number | undefined) => v === undefined ? "n/a" : v.toFixed(1);
  console.log(
    `[sender-echo] ctx=${context} arm=${arm} n=${sorted.length} ` +
      `p50=${fmt(q(0.5))}ms p95=${fmt(q(0.95))}ms ` +
      `min=${fmt(sorted[0])}ms max=${fmt(sorted[sorted.length - 1])}ms ` +
      `abandoned=${report.abandoned.length}`,
  );
  if (report.samples.length > 0) {
    console.log(
      `[sender-echo] per-event ms: ${
        report.samples.map((s) => s.echoMs.toFixed(1)).join(" ")
      }`,
    );
  }
  for (const row of report.abandoned) {
    console.log(
      `[sender-echo] abandoned: ${row.label} (${row.reason}) text="${row.text}"`,
    );
  }
}

export class StepTimer {
  #rows: Array<{ label: string; ms: number }> = [];

  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const presentation = getPresentationSession();
      return presentation ? await presentation.step(label, fn) : await fn();
    } finally {
      this.#rows.push({ label, ms: Math.round(performance.now() - start) });
    }
  }

  rows(): ReadonlyArray<{ label: string; ms: number }> {
    return this.#rows;
  }
}

export function logStepTimings(label: string, timer: StepTimer): void {
  const rows = timer.rows();
  if (rows.length === 0) return;
  const total = rows.reduce((sum, row) => sum + row.ms, 0);
  const lines = rows.map((row) =>
    `  ${String(row.ms).padStart(8)}ms  ${row.label}`
  );
  console.log(
    `\n[${label}] step timings (total ${total}ms):\n${lines.join("\n")}`,
  );
}

export function logBrowserLoadSummary(summary: BrowserLoadSummary): void {
  const formatRows = (rows: TimingStatRow[]): string =>
    rows.length === 0
      ? "    (none)"
      : rows.map((row) =>
        `    ${row.key.padEnd(30)} n=${String(row.count).padStart(5)}` +
        ` p50=${String(row.p50).padStart(8)} p95=${
          String(row.p95).padStart(8)
        }` +
        ` max=${String(row.max).padStart(9)} total=${
          String(row.total).padStart(10)
        }`
      ).join("\n");
  const c = summary.churn;
  const churnLine = `    actionRuns=${c.actionRuns}` +
    ` commitConflicts=${c.commitConflicts} commitReverts=${c.commitReverts}` +
    ` commitRejected=${c.commitRejected}` +
    ` scheduleRunErrors=${c.scheduleRunErrors}` +
    ` eventLostRaces=${c.eventLostRaces}` +
    ` overlayLateEchoDrops=${c.overlayLateEchoDrops}` +
    ` overlayArrivalSweeps=${c.overlayArrivalSweeps}` +
    ` overlayIntentChecks=${c.overlayIntentChecks}` +
    ` overlayIntentsByConsequenceOf=${c.overlayIntentsByConsequenceOf}` +
    ` overlayIntentEchoBackstops=${c.overlayIntentEchoBackstops}` +
    ` overlayCascadeEchoRetired=${c.overlayCascadeEchoRetired}` +
    ` overlayCascadeEchoFlickers=${c.overlayCascadeEchoFlickers}`;
  const pendingLine = summary.pendingIpc.length === 0
    ? "    (none)"
    : summary.pendingIpc.map((row) =>
      `    ${row.type.padEnd(30)} age=${row.ageMs}ms`
    ).join("\n");
  const workerIpcEntries = Object.entries(summary.workerIpc);
  const workerIpcLine = workerIpcEntries.length === 0
    ? "    (none)"
    : workerIpcEntries.map(([key, count]) => `${key}=${count}`)
      .reduce<string[]>((lines, part) => {
        const last = lines[lines.length - 1];
        if (last !== undefined && (last.length + part.length) < 96) {
          lines[lines.length - 1] = `${last} ${part}`;
        } else {
          lines.push(`    ${part}`);
        }
        return lines;
      }, [])
      .join("\n");
  // One request per line, in send order: `sent..done type` (offsets ms from
  // connection construction). `..pending` marks a request never settled. Slow
  // requests visibly nest/overlap here in a way the aggregate table can't show.
  const timelineLine = summary.requestTimeline.length === 0
    ? "    (none)"
    : summary.requestTimeline.map((row) =>
      `    ${String(row.sentAtMs).padStart(7)}..${
        row.doneAtMs !== undefined
          ? String(row.doneAtMs).padStart(7)
          : "pending"
      } ${row.type}${
        row.outcome ? ` ${row.outcome}` : row.error ? " ERROR" : ""
      }`
    ).join("\n");
  console.log(
    `\n[${summary.label}] main-thread runtime-client IPC waits (ms):\n` +
      `${formatRows(summary.ipc)}\n` +
      `[${summary.label}] terminal IPC failures (ms):\n` +
      `${formatRows(summary.ipcFailures)}\n` +
      `[${summary.label}] main-thread IPC still pending:\n${pendingLine}\n` +
      `[${summary.label}] request timeline (sentAt..doneAt ms):\n` +
      `${timelineLine}\n` +
      `[${summary.label}] worker request ledger (received/responded):\n` +
      `${workerIpcLine}\n` +
      `[${summary.label}] worker scheduler/runner/storage (${summary.workerStatus}, ms):\n` +
      `${formatRows(summary.worker)}\n` +
      `[${summary.label}] churn / conflict counters:\n${churnLine}`,
  );
}

type GraphNode = {
  id: string;
  type: "effect" | "computation" | "input" | "inactive";
  stats?: {
    runCount: number;
    totalTime: number;
    averageTime: number;
    lastRunTime: number;
  };
};

async function textIsPresent(
  page: Page,
  selector: string,
  text: string,
): Promise<boolean> {
  try {
    return await page.evaluate((targetSelector, targetText) => {
      function collect(root: Document | ShadowRoot, result: Element[]): void {
        for (const element of root.querySelectorAll("*")) {
          try {
            if (element.matches(targetSelector)) {
              result.push(element);
            }
          } catch {
            // Invalid selectors are reported through the empty probe.
          }
          if (element.shadowRoot) {
            collect(element.shadowRoot, result);
          }
        }
      }

      function deepText(root: ParentNode): string {
        const parts: string[] = [];
        if (root instanceof HTMLElement) {
          const style = globalThis.getComputedStyle(root);
          const hidden = root instanceof HTMLStyleElement ||
            root instanceof HTMLScriptElement ||
            root.hidden ||
            style.visibility === "hidden" ||
            style.display === "none";
          if (!hidden) {
            const innerText = root.innerText ?? "";
            parts.push(
              innerText.trim().length > 0 ? innerText : root.textContent ?? "",
            );
          }
          if (root instanceof HTMLSlotElement) {
            for (const assigned of root.assignedElements({ flatten: true })) {
              parts.push(deepText(assigned));
            }
          }
          if (root.shadowRoot) {
            parts.push(deepText(root.shadowRoot));
          }
        } else if (root instanceof Document || root instanceof ShadowRoot) {
          for (const child of root.children) {
            if (child instanceof HTMLElement) {
              parts.push(deepText(child));
            }
          }
        }
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) {
            parts.push(deepText(element.shadowRoot));
          }
        }
        return parts.join(" ");
      }

      const matches: Element[] = [];
      collect(document, matches);
      return matches.some((element) => deepText(element).includes(targetText));
    }, { args: [selector, text] });
  } catch {
    return false;
  }
}

type TrustedActionProbe = {
  action: string;
  lastClick?: {
    trusted: boolean;
    path: Array<{
      tagName: string;
      id: string;
      dataset: Record<string, string>;
    }>;
  };
  matches: Array<{
    tagName: string;
    text: string;
    rect: { width: number; height: number; top: number; left: number };
    disabled: boolean;
    visible: boolean;
    clickTarget: {
      tagName: string;
      text: string;
      rect: { width: number; height: number; top: number; left: number };
      disabled: boolean;
      visible: boolean;
    };
  }>;
  bodyText: string;
};

type TextProbe = {
  selector: string;
  matches: Array<{
    tagName: string;
    text: string;
    rect: { width: number; height: number; top: number; left: number };
    visible: boolean;

    /** Whether the match, or the control it wraps, declines a click. */
    disabled: boolean;
  }>;
  bodyText: string;
};

type CfInputProbe = {
  selector: string;
  found: boolean;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  hostTagName: string;

  /** Whether the host custom element's definition was registered/upgraded. */
  hostUpgraded?: boolean;

  /** Whether the host exposes `commit()` (a cell-committing form field). */
  hostHasCommit?: boolean;

  /**
   * The host's `value` property: `{ kind: "cell", id, space, path }` for a
   * bound cell handle, otherwise `{ kind: typeof value }`. A fill that stalls
   * in `commit()` with no bound cell points at binding materialization; with a
   * bound cell it points at the cell:set round-trip.
   */
  hostValueBinding?: unknown;

  /** Progress ledger left by fillAndVerify for this selector (see there). */
  fill?: unknown;

  /** In-flight runtime IPC requests at probe time ({ type, ageMs }). */
  pendingIpc?: unknown;

  /** Completed runtime IPC round-trips at probe time ({ count, maxMs }). */
  completedIpc?: unknown;

  /** Cell subscription totals (active instances, backend subscribes). */
  subscriptionTotals?: unknown;

  /** Bounded tail of the page's console messages (see Page wrapper). */
  consoleTail?: unknown;
};

async function readCfInputProbe(
  page: Page,
  selector: string,
): Promise<CfInputProbe> {
  return await page.evaluate((targetSelector) => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        try {
          if (element.matches(targetSelector)) result.push(element);
        } catch {
          // Invalid selectors are reported through the empty probe.
        }
        if (element.shadowRoot) collect(element.shadowRoot, result);
      }
    }

    // Page-level context that is meaningful whether or not the element
    // resolved: the fill's progress ledger, the runtime connection's pending
    // and completed IPC requests, and the recent console tail. This is what
    // turns a bare timeout into a diagnosis (which await stalled, on which
    // request, with which page-side errors around it).
    const g = globalThis as typeof globalThis & {
      __cfFillDiag?: Record<string, unknown>;
      __cfConsoleTail?: Array<{ t: number; method: string; text: string }>;
      commonfabric?: {
        rt?: {
          getPendingRequests?: () => Array<
            { msgId: number; type: string; ageMs: number }
          >;
          getSubscriptionDiagnostics?: () => { totals: unknown };
        };
        getTimingStatsBreakdown?: () => Record<
          string,
          Record<string, { count?: number; max?: number }>
        >;
      };
    };
    const fill = g.__cfFillDiag?.[targetSelector];
    let pendingIpc: unknown;
    try {
      pendingIpc = g.commonfabric?.rt?.getPendingRequests?.()
        .map(({ type, ageMs }) => ({ type, ageMs }));
    } catch (error) {
      pendingIpc = `unavailable: ${error}`;
    }
    let completedIpc: unknown;
    try {
      const rows = g.commonfabric?.getTimingStatsBreakdown?.()
        ?.["runtime-client"];
      completedIpc = rows
        ? Object.fromEntries(
          Object.entries(rows).map(([key, stats]) => [key, {
            count: stats.count ?? 0,
            maxMs: Math.round(stats.max ?? 0),
          }]),
        )
        : undefined;
    } catch (error) {
      completedIpc = `unavailable: ${error}`;
    }
    let subscriptionTotals: unknown;
    try {
      subscriptionTotals = g.commonfabric?.rt?.getSubscriptionDiagnostics?.()
        .totals;
    } catch (error) {
      subscriptionTotals = `unavailable: ${error}`;
    }
    const consoleTail = (g.__cfConsoleTail ?? []).slice(-40);
    const context = {
      fill,
      pendingIpc,
      completedIpc,
      subscriptionTotals,
      consoleTail,
    };

    const matches: Element[] = [];
    collect(document, matches);
    const element = matches[0];
    if (!element) {
      return {
        selector: targetSelector,
        found: false,
        value: "",
        disabled: false,
        readOnly: false,
        visible: false,
        hostTagName: "",
        ...context,
      };
    }
    const input = element instanceof HTMLInputElement
      ? element
      : element.shadowRoot?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      return {
        selector: element.tagName.toLowerCase(),
        found: false,
        value: "",
        disabled: false,
        readOnly: false,
        visible: false,
        hostTagName: element.tagName.toLowerCase(),
        ...context,
      };
    }
    const rect = input.getBoundingClientRect();
    const style = globalThis.getComputedStyle(input);
    const visible = rect.width > 0 && rect.height > 0 &&
      rect.bottom >= 0 && rect.right >= 0 &&
      rect.top <= globalThis.innerHeight &&
      rect.left <= globalThis.innerWidth &&
      style.visibility !== "hidden" && style.display !== "none";
    const root = input.getRootNode();
    const host = root instanceof ShadowRoot ? root.host : element;
    const hostTagName = host.tagName.toLowerCase();
    const hostValue = (host as Element & { value?: unknown }).value;
    let hostValueBinding: unknown;
    if (
      hostValue !== null && typeof hostValue === "object" &&
      typeof (hostValue as { ref?: unknown }).ref === "function"
    ) {
      try {
        const ref = (hostValue as {
          ref: () => { id?: unknown; space?: unknown; path?: unknown };
        }).ref();
        const trim = (v: unknown) =>
          typeof v === "string" && v.length > 28 ? `${v.slice(0, 28)}…` : v;
        hostValueBinding = {
          kind: "cell",
          id: trim(ref.id),
          space: trim(ref.space),
          path: ref.path,
        };
      } catch (error) {
        hostValueBinding = { kind: "cell", error: String(error) };
      }
    } else {
      hostValueBinding = { kind: typeof hostValue };
    }
    return {
      selector: input.tagName.toLowerCase(),
      found: true,
      value: input.value,
      disabled: input.disabled,
      readOnly: input.readOnly,
      visible,
      hostTagName,
      hostUpgraded: hostTagName.includes("-")
        ? customElements.get(hostTagName) !== undefined
        : true,
      hostHasCommit:
        typeof (host as Element & { commit?: unknown }).commit === "function",
      hostValueBinding,
      ...context,
    };
  }, { args: [selector] });
}

async function readDisabledProbe(
  page: Page,
  selector: string,
): Promise<{ selector: string; disabled?: boolean }> {
  return await page.evaluate((targetSelector) => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        try {
          if (element.matches(targetSelector)) result.push(element);
        } catch {
          // Invalid selectors are reported through the empty probe.
        }
        if (element.shadowRoot) collect(element.shadowRoot, result);
      }
    }

    const matches: Element[] = [];
    collect(document, matches);
    const element = matches[0];
    if (!element) return { selector: targetSelector, disabled: undefined };
    // Resolve disabled the same way `disabledIs` does, so the diagnostic reports
    // the state the wait was actually testing: an inner <button> when present,
    // else the host's own `.disabled` (native controls) or its `disabled` /
    // `aria-disabled` attributes (custom elements like cf-checkbox).
    const button = element instanceof HTMLButtonElement
      ? element
      : element.shadowRoot?.querySelector("button");
    let disabled: boolean;
    if (button instanceof HTMLButtonElement) {
      disabled = button.disabled;
    } else if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      disabled = element.disabled;
    } else {
      disabled = element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true";
    }
    return {
      selector: element.tagName.toLowerCase(),
      disabled,
    };
  }, { args: [selector] });
}

/** Remove the click mark carrying `token` from wherever it landed. */
async function clearClickMark(
  page: Page,
  token: string,
): Promise<void> {
  await page.evaluate((targetToken, targetAttr) => {
    const markTokens = (element: Element): string[] =>
      (element.getAttribute(targetAttr) ?? "").split(/\s+/).filter(Boolean);

    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        if (markTokens(element).includes(targetToken)) {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    const matches: Element[] = [];
    collect(document, matches);
    for (const element of matches) {
      const remaining = markTokens(element).filter((mark) =>
        mark !== targetToken
      );
      if (remaining.length === 0) {
        element.removeAttribute(targetAttr);
      } else {
        element.setAttribute(targetAttr, remaining.join(" "));
      }
    }
  }, { args: [token, CLICK_TARGET_ATTR] });
}

// What the interceptor the aim armed made of the trusted click that followed.
async function readClickLanding(
  page: Page,
  selector: string,
): Promise<ClickLanding> {
  return await page.evaluate((targetSelector: string) => {
    const landing = (globalThis as typeof globalThis & {
      __cfClickLanding?: Record<
        string,
        { verdict: "pending" | "hit" | "missed"; path: string }
      >;
    }).__cfClickLanding?.[targetSelector];
    return {
      verdict: landing?.verdict ?? "pending",
      path: landing?.path ?? "",
    };
  }, { args: [selector] });
}

// Let the aim arm an interceptor for this mark. An aim that runs outside this
// window — one whose wait the test process has already given up on — leaves the
// page alone.
async function openClickLanding(
  page: Page,
  selector: string,
): Promise<void> {
  await page.evaluate((targetSelector: string) => {
    ((globalThis as typeof globalThis & {
      __cfClickLandingOpen?: Record<string, true>;
    }).__cfClickLandingOpen ??= {})[targetSelector] = true;
  }, { args: [selector] });
}

// Close the window and take the interceptor off the page, so the page's own
// clicks are watched by nothing.
async function closeClickLanding(
  page: Page,
  selector: string,
): Promise<void> {
  await page.evaluate((targetSelector: string) => {
    const global = globalThis as typeof globalThis & {
      __cfClickLanding?: Record<string, { detach: () => void }>;
      __cfClickLandingOpen?: Record<string, true>;
    };
    delete global.__cfClickLandingOpen?.[targetSelector];
    global.__cfClickLanding?.[targetSelector]?.detach();
    delete global.__cfClickLanding?.[targetSelector];
  }, { args: [selector] });
}

async function readTrustedActionProbe(
  page: Page,
  action: string,
): Promise<TrustedActionProbe> {
  return await page.evaluate((targetAction) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute("data-ui-action") === targetAction) {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function isVisible(element: HTMLElement): boolean {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= globalThis.innerHeight &&
        rect.left <= globalThis.innerWidth &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    }

    function isDisabled(element: HTMLElement): boolean {
      return element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true";
    }

    const matches: Element[] = [];
    collect(document, matches);
    const lastClick = (globalThis as typeof globalThis & {
      __lastCfcTrustedActionClick?: TrustedActionProbe["lastClick"];
    }).__lastCfcTrustedActionClick;
    return {
      action: targetAction,
      ...(lastClick ? { lastClick } : {}),
      matches: matches.map((element) => {
        const target = element as HTMLElement;
        const clickTarget =
          (target.shadowRoot?.querySelector("[data-cf-button]") as
            | HTMLElement
            | null) ?? target;
        const rect = target.getBoundingClientRect();
        const clickRect = clickTarget.getBoundingClientRect();
        return {
          tagName: target.tagName.toLowerCase(),
          text: (target.textContent ?? "").trim().slice(0, 200),
          rect: {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
          },
          disabled: isDisabled(target) || isDisabled(clickTarget),
          visible: isVisible(target) && isVisible(clickTarget),
          clickTarget: {
            tagName: clickTarget.tagName.toLowerCase(),
            text: (clickTarget.textContent ?? "").trim().slice(0, 200),
            rect: {
              width: clickRect.width,
              height: clickRect.height,
              top: clickRect.top,
              left: clickRect.left,
            },
            disabled: isDisabled(clickTarget),
            visible: isVisible(clickTarget),
          },
        };
      }),
      bodyText: (document.body?.innerText ?? "").slice(0, 1_000),
    };
  }, { args: [action] });
}

/**
 * How far the aim for `selector` got, and what it last measured. `aimAtMarkedTarget`
 * keeps this ledger in the page as it works, so a stalled aim names the step it
 * died in — resolving the mark, settling the box, or reading the point — rather
 * than reporting only that no point ever arrived.
 */
async function readAimProgress(
  page: Page,
  selector: string,
): Promise<unknown> {
  return await page.evaluate((targetSelector: string) => ({
    aim: (globalThis as typeof globalThis & {
      __cfAimDiag?: Record<string, unknown>;
    }).__cfAimDiag?.[targetSelector],
    documentVisibility: document.visibilityState,
  }), { args: [selector] });
}

/**
 * What `selector` resolves to on `page`, for a failure report: every match
 * through shadow roots, each with the text a wait's predicate reads through
 * `probe.deepText`, its box, whether it is visible, and whether it declines a
 * click; plus the page's body text where there is no match at all.
 *
 * The helpers here build their own failure messages with it. A test building
 * one of its own reaches for it rather than walking the shadow roots again,
 * which would report a different traversal from the one its wait was reading.
 */
export async function readTextProbe(
  page: Page,
  selector: string,
): Promise<TextProbe> {
  return await page.evaluate((targetSelector) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        try {
          if (element.matches(targetSelector)) {
            result.push(element);
          }
        } catch {
          // Invalid selectors are reported through the empty probe.
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function isVisible(element: HTMLElement): boolean {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= globalThis.innerHeight &&
        rect.left <= globalThis.innerWidth &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    }

    // Resolved the way a click helper's finder resolves it, so a match a wait
    // is holding for reports the state that wait is testing. A control that is
    // rendered and visible and still not clicked is what this answers for.
    // Spelled out rather than taken from `probe`, which a plain page evaluate
    // is not handed.
    function isDisabled(element: HTMLElement): boolean {
      const declines = (candidate: Element): boolean =>
        candidate.hasAttribute("disabled") ||
        candidate.getAttribute("aria-disabled") === "true";
      const inner = element.shadowRoot?.querySelector("[data-cf-button]") ??
        element;
      return declines(element) || declines(inner);
    }

    function deepText(root: ParentNode): string {
      const parts: string[] = [];
      if (root instanceof HTMLElement) {
        const style = globalThis.getComputedStyle(root);
        const hidden = root instanceof HTMLStyleElement ||
          root instanceof HTMLScriptElement ||
          root.hidden ||
          style.visibility === "hidden" ||
          style.display === "none";
        if (!hidden) {
          const innerText = root.innerText ?? "";
          parts.push(
            innerText.trim().length > 0 ? innerText : root.textContent ?? "",
          );
        }
        if (root instanceof HTMLSlotElement) {
          for (const assigned of root.assignedElements({ flatten: true })) {
            parts.push(deepText(assigned));
          }
        }
        if (root.shadowRoot) {
          parts.push(deepText(root.shadowRoot));
        }
      } else if (root instanceof Document || root instanceof ShadowRoot) {
        for (const child of root.children) {
          if (child instanceof HTMLElement) {
            parts.push(deepText(child));
          }
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          parts.push(deepText(element.shadowRoot));
        }
      }
      return parts.join(" ");
    }

    const matches: Element[] = [];
    collect(document, matches);
    return {
      selector: targetSelector,
      matches: matches.map((element) => {
        const target = element as HTMLElement;
        const rect = target.getBoundingClientRect();
        return {
          tagName: target.tagName.toLowerCase(),
          text: deepText(target).trim().slice(
            0,
            500,
          ),
          rect: {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
          },
          visible: isVisible(target),
          disabled: isDisabled(target),
        };
      }),
      bodyText: document.body === null
        ? ""
        : deepText(document.body).trim().slice(0, 1_000),
    };
  }, { args: [selector] });
}
