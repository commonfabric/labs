/**
 * Event message types for DOM events sent from main thread to worker.
 *
 * When a DOM event fires on the main thread, it is serialized and
 * sent to the worker thread for dispatch to the appropriate handler.
 */

import {
  type FabricValue,
  isValidFabricValueLayer,
} from "@commonfabric/data-model";
import type { SigilLink } from "@commonfabric/runner/shared";
import { isCellHandle } from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  type EventProvenance,
  getEventProvenance,
  getEventTargetDataset,
} from "./event-provenance.ts";

/**
 * Serialized DOM event data.
 * Contains a subset of event properties that are safe to serialize.
 */
export type SerializedEvent = {
  /** Event type (e.g., "click", "input", "change") */
  type: string;

  /** Internal provenance hint from the renderer */
  provenance?: EventProvenance;

  // Keyboard event properties
  key?: string;
  code?: string;
  repeat?: boolean;

  // Modifier keys (keyboard & mouse)
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;

  // Input event properties
  inputType?: string;
  data?: string | null;

  // Mouse event properties
  button?: number;
  buttons?: number;

  // Target properties
  target?: SerializedEventTarget;

  // Custom event detail
  detail?: FabricValue;
};

export type { EventProvenance };

/**
 * Serialized event target data.
 * Contains common input element properties.
 */
export type SerializedEventTarget = {
  /** The element's name, or the link to a cell bound in its place. */
  name?: string | SigilLink;

  /**
   * The element's current value, or the link to a cell bound in its place.
   *
   * The one member here that no scalar covers, and so the one still typed as
   * wide as the domain. Components declare theirs `string` and
   * `CellHandle<string> | string` mostly, but also `string | string[]`,
   * `number`, and in one case `CellHandle<unknown> | unknown`.
   */
  value?: FabricValue;

  /**
   * Whether the element is checked -- or, where the element chose to expose
   * something else, what it chose. `cf-checkbox` and `cf-switch` each declare
   * theirs as `CellHandle<boolean> | boolean`.
   */
  checked?: boolean | SigilLink;

  /** Whether the element reports itself selected, or the link bound in place. */
  selected?: boolean | SigilLink;

  /**
   * Which option a select is on, or the link bound in its place -- `cf-picker`
   * declares its `selectedIndex` a `CellHandle<number>`.
   */
  selectedIndex?: number | SigilLink;

  /** Every selected option's value, for a multiple select. */
  selectedOptions?: { value: string }[];

  /** The element's `data-` attributes. */
  dataset?: Record<string, string>;
};

/**
 * Message sent from main thread to worker when a DOM event fires.
 */
export interface DomEventMessage {
  type: "dom-event";

  /** The handler ID that should process this event */
  handlerId: number;

  /** The serialized event data */
  event: SerializedEvent;

  /** The node ID where the event occurred */
  nodeId: number;
}

/**
 * Type guard for DomEventMessage.
 */
export function isDomEventMessage(value: unknown): value is DomEventMessage {
  return isObjectOrArray(value) &&
    value.type === "dom-event" &&
    typeof value.handlerId === "number" &&
    isObjectOrArray(value.event) &&
    typeof value.nodeId === "number";
}

/**
 * The type the DOM defines for a property, as a tag a read can be checked
 * against. `"string?"` is `string | null`, which is what an input event's
 * `data` is when there is no inserted text.
 */
type DomScalar = "string" | "string?" | "boolean" | "number";

/** Whether a value is what its {@link DomScalar} tag says it is. */
function matchesDomScalar(value: unknown, tag: DomScalar): boolean {
  switch (tag) {
    case "string":
      return typeof value === "string";
    case "string?":
      return (value === null) || (typeof value === "string");
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
  }
}

/**
 * Event properties that cross, each with the type the DOM defines for it. Every
 * one is a `FabricValue`, which is what lets them cross as they are.
 */
export const ALLOWLISTED_EVENT_PROPERTIES = {
  type: "string",
  key: "string",
  code: "string",
  repeat: "boolean",
  altKey: "boolean",
  ctrlKey: "boolean",
  metaKey: "boolean",
  shiftKey: "boolean",
  inputType: "string",
  data: "string?",
  button: "number",
  buttons: "number",
} as const satisfies Partial<Record<keyof SerializedEvent, DomScalar>>;

/**
 * Target properties that cross.
 *
 * Each may be the link that reaches a cell bound in its place, whatever else it
 * may be. The JSX contract admits a cell for any attribute of any element --
 * `DetailedHTMLProps` maps each prop to `E[K] | CellLike<E[K]>` -- and a bound
 * one reaches the element as a `CellHandle`, regardless of what the component
 * declares its own property to be.
 */
export const ALLOWLISTED_TARGET_PROPERTIES = [
  "name",
  "value",
  "checked",
  "selected",
  "selectedIndex",
] as const satisfies readonly (keyof SerializedEventTarget)[];

/**
 * What each target property may be when it is *not* a link, where one type
 * covers it.
 *
 * `value` has no entry, no scalar covering what components declare theirs to
 * be: `string` and `CellHandle<string> | string` mostly, but also
 * `string | string[]`, `number`, and in one case `CellHandle<unknown> |
 * unknown`. So it is the one that crosses as whatever
 * {@link toSerializableValue} makes of it.
 */
const TARGET_PROPERTY_SCALARS = {
  name: "string",
  checked: "boolean",
  selected: "boolean",
  selectedIndex: "number",
} as const satisfies Partial<Record<keyof SerializedEventTarget, DomScalar>>;

/**
 * Serialize a DOM event for IPC transmission.
 * This creates a plain object with only safe, serializable properties.
 */
export function serializeEvent(event: Event): SerializedEvent {
  const serialized: SerializedEvent = {
    type: event.type,
  };
  const provenance = getEventProvenance(event, event.target);
  if (provenance) {
    serialized.provenance = provenance;
  }

  // Each checked against the type the DOM defines for it, which is what makes
  // the write the field type `SerializedEvent` declares rather than a claim
  // about it. A property of some other type is one no producer here dispatches,
  // and is left out rather than carried into a field that cannot hold it.
  copyDomScalars(
    event as unknown as Record<string, unknown>,
    serialized as unknown as Record<string, unknown>,
    ALLOWLISTED_EVENT_PROPERTIES,
  );

  // Copy target properties
  const target = event.target;
  if (target && typeof target === "object") {
    const serializedTarget: SerializedEventTarget = {};
    let hasTargetProps = false;

    const from = target as unknown as Record<string, unknown>;
    const to = serializedTarget as unknown as Record<string, unknown>;

    for (const prop of ALLOWLISTED_TARGET_PROPERTIES) {
      const value = from[prop];
      if (value === undefined) continue;

      const carried = carriedTargetValue(prop, value);
      if (carried === undefined) continue;

      to[prop] = carried;
      hasTargetProps = true;
    }

    // Handle select element's selectedOptions
    if (
      "selectedOptions" in target &&
      target.selectedOptions instanceof HTMLCollection
    ) {
      serializedTarget.selectedOptions = Array.from(target.selectedOptions).map(
        (option) => ({ value: (option as HTMLOptionElement).value }),
      );
      hasTargetProps = true;
    }

    // Handle the event target's own dataset. UI contract markers from the
    // composed path are serialized separately in provenance.
    const dataset = getEventTargetDataset(target);
    if (dataset) {
      serializedTarget.dataset = dataset;
      hasTargetProps = true;
    }

    if (hasTargetProps) {
      serialized.target = serializedTarget;
    }
  }

  // TODO(danfuzz): a `detail` is a whole value a component chose to hand the
  // pattern, and the pattern's handler receives it as a `FabricValue`. The
  // conversion below takes each member as it stands, so one with a fabric form
  // but a native spelling -- a `Date`, a `Uint8Array`, an `Error` -- is refused
  // by the encoding at the crossing, and the event dies there rather than
  // degrading. Minting such a member into fabric form here carries a `Date` and
  // a `Uint8Array` whole; an `Error` becomes a `FabricError`, which waits on
  // the worker's event ingress descending a `FabricInstance` rather than
  // refusing one. The same holds of a target's `value` and `checked` above. The
  // outbound half of this seam is closed: `SetPropOp.value` in `../vdom-ops.ts`
  // is a `FabricValue` the envelope's encoding carries whole.
  if ("detail" in event && (event as CustomEvent).detail !== undefined) {
    serialized.detail = toSerializableValue((event as CustomEvent).detail);
  }

  return serialized;
}

/**
 * Copies each named property that is present and is what its tag says.
 *
 * The two casts are the loop's rather than a claim about the values: what is
 * read is a property of whatever object was dispatched, and what is written has
 * been checked before it goes.
 */
function copyDomScalars(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  tags: Readonly<Record<string, DomScalar>>,
): void {
  for (const [prop, tag] of Object.entries(tags)) {
    const value = from[prop];
    if ((value !== undefined) && matchesDomScalar(value, tag)) {
      to[prop] = value;
    }
  }
}

/**
 * What one target property crosses as, or `undefined` where it crosses as
 * nothing.
 *
 * A `CellHandle` goes first and is recognized by its class rather than by its
 * offering a `toJSON()`, so that nothing else defining one is taken for a cell.
 * It is what a bound property holds: the applicator installs the handle on the
 * element (`setBinding()` in `./applicator.ts`) and the components leave it
 * there, `cf-input`'s controller binding `value` without replacing it and
 * `cf-checkbox`'s doing the same with `checked`. What crosses is the link that
 * reaches the cell, which is what makes each of these `T | SigilLink`.
 *
 * Otherwise the property is whatever its own scalar admits. One that admits
 * nothing else -- `value`, per {@link TARGET_PROPERTY_SCALARS} -- goes to the
 * general conversion; one that fails its scalar crosses as nothing, rather than
 * landing in a field that says it cannot hold it.
 */
function carriedTargetValue(
  prop: typeof ALLOWLISTED_TARGET_PROPERTIES[number],
  value: unknown,
): FabricValue | undefined {
  if (isCellHandle(value)) return value.toSigilLink();

  const scalar: DomScalar | undefined = TARGET_PROPERTY_SCALARS[
    prop as keyof typeof TARGET_PROPERTY_SCALARS
  ];

  if (scalar === undefined) return toSerializableValue(value);

  return matchesDomScalar(value, scalar) ? value as FabricValue : undefined;
}

/**
 * Converts one value a component exposed to the event into the form the VDOM
 * event notification carries, and refuses what has no such form.
 *
 * A `FabricValue` crosses as itself. The connection carries that whole domain,
 * so there is nothing to convert, and walking one would only be a chance to
 * lose something. A cycle is a `FabricValue` too, and crosses as one; whether
 * it can be carried further is the encoding's question at the crossing rather
 * than this seam's.
 *
 * Only the top layer is examined, which is what keeps this off the per-event
 * cost of a walk. A container whose members are not fabric is the producer's
 * bug and fails at the crossing, where the encoding names the member it cannot
 * take -- so a deep check here would spend a walk on every correct value to
 * reach a verdict the encoding reaches anyway.
 *
 * A `CellHandle` is the one thing a component exposes that is not fabric and
 * has a representation anyway: the link that reaches its cell. Recognized by
 * its class, and asked for its link by name -- nothing here reaches for a
 * serialization protocol that happens to yield one.
 *
 * Anything else is refused: a value whose very top layer has no fabric form.
 *
 * What a component puts in a detail that cannot cross is enumerable, and none
 * of it is something a handler could act on. Each rides as a *member* of a
 * plain-object detail, which is the encoding's verdict at the crossing rather
 * than this refusal's; what reaches here is a detail that is one of them
 * outright:
 *
 * * an `Error`, from `cf-error` -- raised by `cf-code-editor`, `cf-file-input`
 *   and `cf-voice-input` -- and from the separately named `cf-download-error`
 *   and `cf-autosave-error` of `cf-file-download`, `cf-copy-error` of
 *   `cf-copy-button`, and `cf-transcription-error` of `cf-voice-input`.
 * * a `Blob`, from `cf-voice-input`'s `cf-recording-stop`, as `audioData`.
 * * a `FileList`, from `cf-input`'s own `cf-input` event, which carries `files`
 *   when the input's `type` is `file`.
 * * an `Element`, from `cf-tab`'s `tab-click` and `cf-tab-bar-item`'s
 *   `tab-bar-click`, each of which puts itself in its own detail.
 * * a `Date`, a `Map`, a `Set`, a `RegExp`, or an object that merely defines a
 *   `toJSON()`. No component exposes one.
 *
 * Nothing binds a handler to any of those events, so none of it crosses today.
 * Deliberately absent from the list, being already answered above: the file
 * inputs' `cf-change`, which carries `StoredFile` records -- plain records of
 * scalars, which cross as themselves.
 *
 * The refusal is a tripwire rather than a verdict on any of them. The set this
 * accepts is expected to grow, and where each refused value should go instead
 * is undecided: a `Blob` and a `FileList` want records or `FabricBytes` at the
 * producer, an `Error` wants a `FabricError` once the worker's event ingress
 * descends an instance rather than refusing one, and an `Element` cannot cross
 * at all and wants its producer to name what it means instead.
 *
 * @throws If the value is neither of the two that cross. It leaves the DOM
 *   listener that called this, which loses the event and reports as an uncaught
 *   page error -- and which is what makes a reachable case unmissable, the
 *   browser suites failing a test on any uncaught page exception.
 */
function toSerializableValue(value: unknown): FabricValue {
  if (isValidFabricValueLayer(value)) return value as FabricValue;

  if (isCellHandle(value)) return value.toSigilLink();

  throw new Error(
    "Cannot yet carry this value on a DOM event, it being neither a " +
      `\`FabricValue\` nor a \`CellHandle\`: ${describeUnconvertible(value)}`,
  );
}

/**
 * Renders a value with no JSON form as text, for a description that must be
 * produced whatever it is handed.
 *
 * A value can refuse even to be coerced: `String()` reaches for `toString` and
 * `valueOf`, and an object made with `Object.create(null)` has no prototype to
 * find either on. `/unconvertible` is the fixed token for that.
 */
function describeUnconvertible(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "/unconvertible";
  }
}
