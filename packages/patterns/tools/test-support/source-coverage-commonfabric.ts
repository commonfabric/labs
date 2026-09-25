/**
 * The `commonfabric` module the pattern source-coverage harness runs patterns
 * against. See `test/source-coverage/pattern-source-coverage.test.ts` for the
 * harness itself: it runs
 * changed pattern modules as plain code under Deno's V8 coverage, deliberately
 * without the transformer + sandbox + runtime, and its generated import map
 * points `commonfabric` at this file.
 *
 * So this stands in for the real `commonfabric` surface, and is two things at
 * once:
 *
 * - Fakes for the reactive primitives (`pattern`, `handler`, `computed`,
 *   `lift`, `Cell`/`Writable`, streams, `wish`, `fetch*`, …). These normally
 *   need the live runtime; here they are synchronous, runtime-free stand-ins
 *   that just let the authored source execute so its lines are counted. Their
 *   return values are scaffolding — the harness asserts on rendered output, not
 *   on what these produce — so keep them minimal.
 * - Real re-exports of the pure, runtime-free `data-model` helpers
 *   (`valueEqual`, `toCompactDebugString`, `toIndentedDebugString`,
 *   `debugStr`). Faking these would both duplicate real code and rob the
 *   harness of a bonus: because the child inherits `DENO_COVERAGE_DIR`,
 *   running the real ones gives `data-model` (and its foundation deps)
 *   coverage credit for the paths the pattern runtime exercises.
 *
 * Anything a pattern imports from `commonfabric` must be exported here, or that
 * pattern fails to load in the child (not caught by `deno check`). The child
 * runs this file under `--no-check`, so `deno task check`, which lists
 * `packages/patterns/tools`, is what type-checks it.
 */

//
// Real implementation pass-through
//

// The generated child import map resolves the transitive
// `data-model`/`content-hash`/`leb128` graph these pull in.
import { type FabricValue, valueEqual } from "@commonfabric/data-model";
export { valueEqual };
export {
  debugStr,
  toCompactDebugString,
  toIndentedDebugString,
} from "@commonfabric/data-model";

//
// Stubs
//

export type BuiltInLLMMessage = Record<string, unknown>;
export type BuiltInLLMTool = Record<string, unknown>;
export type Default<T> = T;
export type PatternToolResult<T = Record<string, never>> = {
  pattern: unknown;
  extraParams: T;
};
export type Reactive<T> = T;
export type Stream<T = unknown> = {
  send(event?: T): unknown;
  sendCount: number;
  lastEvent?: T;
};
export type VNode = unknown;
export type WishState<T> = { result?: T; candidates?: T[] };

export const NAME = "__name";
export const UI = "__ui";
export const TILE_UI = "__tile_ui";
export const SELF = "__self";

const wishResults = new Map<string, unknown>();
let generateTextResult: {
  pending: boolean;
  result?: unknown;
  error?: unknown;
} = {
  pending: false,
  result: "",
  error: undefined,
};
let fetchJsonResult: unknown = defaultFetchJsonResult();

function defaultFetchJsonResult(): unknown {
  return {
    name: "stub-repo",
    owner: { login: "stub-owner" },
    description: "stub description",
    stargazers_count: 123,
    forks_count: 0,
    language: "TypeScript",
    html_url: "https://example.com/stub-repo",
  };
}

export function setFetchJsonResult(result: unknown): void {
  fetchJsonResult = result;
}

export function clearFetchJsonResult(): void {
  fetchJsonResult = defaultFetchJsonResult();
}

export function setWishResult(query: string, result: unknown): void {
  wishResults.set(query, result);
}

export function clearWishResults(): void {
  wishResults.clear();
}

export function setGenerateTextResult(result: {
  pending: boolean;
  result?: unknown;
  error?: unknown;
}): void {
  generateTextResult = result;
}

export function clearGenerateTextResult(): void {
  generateTextResult = {
    pending: false,
    result: "",
    error: undefined,
  };
}

export class Writable<T = unknown> {
  static perSession = class<T = unknown> extends Writable<T> {
    static of<T>(value: T): Writable<T> {
      return new Writable.perSession<T>(value);
    }
  };

  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  get(): T {
    return this.#value;
  }

  set(value: T): void {
    this.#value = value;
  }

  push(
    ...values: T extends Array<infer U> ? U[] : unknown[]
  ): void {
    if (!Array.isArray(this.#value)) {
      throw new Error("push requires an array value");
    }
    (this.#value as unknown[]).push(...values);
  }

  addUnique(
    ...values: T extends Array<infer U> ? U[] : unknown[]
  ): void {
    if (!Array.isArray(this.#value)) {
      throw new Error("addUnique requires an array value");
    }
    const current = this.#value;
    for (const value of values) {
      if (!current.some((item) => valueEqual(item, value as FabricValue))) {
        current.push(value as FabricValue);
      }
    }
  }

  removeByValue(value: unknown): void {
    if (!Array.isArray(this.#value)) return;
    this.#value = this.#value.filter((item) =>
      !valueEqual(item, value as FabricValue)
    ) as T;
  }

  key(key: PropertyKey): Writable<unknown> {
    return new Proxy(new Writable(readKey(this.#value, key)), {
      get: (target, property, receiver) => {
        if (property === "get") {
          return () => readKey(this.#value, key);
        }
        if (property === "set") {
          return (value: unknown) => {
            if (this.#value == null) {
              this.#value = (typeof key === "number" ? [] : {}) as T;
            }
            writeKey(this.#value, key, value);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  for(_label: string): this {
    return this;
  }

  sync(): this {
    return this;
  }

  map<U>(callback: (value: unknown, index: number) => U): U[] {
    return Array.isArray(this.#value)
      ? (this.#value as unknown[]).map(callback)
      : [];
  }

  filter(callback: (value: unknown, index: number) => boolean): unknown[] {
    return Array.isArray(this.#value)
      ? (this.#value as unknown[]).filter(callback)
      : [];
  }

  slice(...args: [number?, number?]): unknown[] {
    return Array.isArray(this.#value)
      ? (this.#value as unknown[]).slice(...args)
      : [];
  }

  get length(): number {
    return Array.isArray(this.#value) ? this.#value.length : 0;
  }

  [Symbol.iterator](): IterableIterator<unknown> {
    return Array.isArray(this.#value)
      ? (this.#value as unknown[])[Symbol.iterator]()
      : [][Symbol.iterator]();
  }
}

function readKey(value: unknown, key: PropertyKey): unknown {
  if (value == null) return undefined;
  return (value as Record<PropertyKey, unknown>)[key];
}

function writeKey(value: unknown, key: PropertyKey, nextValue: unknown): void {
  (value as Record<PropertyKey, unknown>)[key] = nextValue;
}

export const Cell = {
  of<T>(value: T): Writable<T> {
    return new Writable(value);
  },
};

export function pattern<TInput, TOutput>(
  body: (input: TInput) => TOutput,
  ..._rest: unknown[]
): (input?: Partial<TInput>) => TOutput {
  return (input = {} as Partial<TInput>) => body(input as TInput);
}

export function handler<TEvent, TState>(
  ...args:
    | [body: (event: TEvent, state: TState) => unknown]
    | [
      _inputSchema: unknown,
      _stateSchema: unknown,
      body: (event: TEvent, state: TState) => unknown,
    ]
): (state: TState) => Stream<TEvent> {
  const body = args[args.length - 1] as (
    event: TEvent,
    state: TState,
  ) => unknown;
  return (state) => {
    const stream: Stream<TEvent> = {
      sendCount: 0,
      send(event?: TEvent) {
        stream.sendCount++;
        stream.lastEvent = event;
        if (body.constructor.name === "AsyncFunction") {
          return Promise.resolve(undefined);
        }
        return body(event as TEvent, state);
      },
    };
    return stream;
  };
}

export function action(body: () => unknown): Stream<void> {
  return {
    sendCount: 0,
    send() {
      this.sendCount++;
      return body();
    },
  };
}

export function computed<T>(body: () => T): T {
  return body();
}

export function lift<TInput, TOutput>(
  body: (input: TInput) => TOutput,
): (input: TInput) => TOutput {
  return (input) => body(input);
}

export function ifElse<T>(condition: unknown, truthy: T, falsy: T): T {
  return condition ? truthy : falsy;
}

export function when<T>(condition: unknown, value: T): T | undefined {
  return condition ? value : undefined;
}

export function unless<T>(condition: unknown, value: T): T | undefined {
  return condition ? undefined : value;
}

export function wish<T>({ query }: { query: string }): WishState<T> {
  return { result: wishResults.get(query) as T | undefined };
}

export function fetchJson<T>(
  _params: Record<string, unknown>,
): { pending: false; result: T; error: undefined } {
  return {
    pending: false,
    // A GitHub-repo-shaped stub: covers both `stargazers_count` readers and
    // patterns that walk further into the response (owner, name, etc.).
    result: fetchJsonResult as T,
    error: undefined,
  };
}

export function fetchJsonUnchecked(
  _params: Record<string, unknown>,
): { pending: false; result: unknown; error: undefined } {
  return {
    pending: false,
    result: { stargazers_count: 123 },
    error: undefined,
  };
}

export function fetchText(
  _params: Record<string, unknown>,
): { pending: false; result: string; error: undefined } {
  return {
    pending: false,
    result: "stub text",
    error: undefined,
  };
}

export function fetchBinary(
  _params: Record<string, unknown>,
): {
  pending: false;
  result: { bytes: Uint8Array; mediaType: string };
  error: undefined;
} {
  return {
    pending: false,
    result: { bytes: new Uint8Array(), mediaType: "application/octet-stream" },
    error: undefined,
  };
}

export function generateObject<T>(
  _params: Record<string, unknown>,
): { pending: false; result: T; error: undefined } {
  return { pending: false, result: {} as T, error: undefined };
}

export function generateText<T>(
  _params: Record<string, unknown>,
): { pending: boolean; result?: T; error?: unknown } {
  return generateTextResult as {
    pending: boolean;
    result?: T;
    error?: unknown;
  };
}

export function llmDialog<T>(
  _params: Record<string, unknown>,
): {
  pending: false;
  result?: T;
  addMessage: Stream<BuiltInLLMMessage>;
  error?: string;
} {
  return {
    pending: false,
    addMessage: handler<BuiltInLLMMessage, Record<string, never>>(() => {})({}),
  };
}

export function patternTool<T>(
  patternValue: unknown,
  extraParams?: T,
): PatternToolResult<T> {
  return { pattern: patternValue, extraParams: extraParams as T };
}

export function toSchema<T>(): T {
  return {} as T;
}

export function str(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += String(values[i]);
  }
  return out;
}

export function equals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function getPatternEnvironment(): { apiUrl: URL } {
  return { apiUrl: new URL("http://localhost/") };
}

export function navigateTo(value: unknown): unknown {
  return value;
}

export function compileAndRun(): { pending: false; result: undefined } {
  return { pending: false, result: undefined };
}

export function fetchProgram(): { pending: false; result: undefined } {
  return { pending: false, result: undefined };
}

export function streamData(): { pending: false; result: undefined } {
  return { pending: false, result: undefined };
}

export function byRef(_ref: string): () => Record<string, never> {
  return () => ({});
}

export function __cf_data<T>(value: T): T {
  return value;
}

//
// Real implementation pass-through, second group
//

// Plain data and one pure predicate, which `@commonfabric/api` both declares
// and implements. The real `commonfabric` surface passes these through from
// there rather than faking them, so this does too -- a fake would be a second
// copy of a list whose whole point is to have one.
export {
  CFC_CANONICAL_ALIAS_NAMES,
  FABRIC_INSTANCE_PLUS_BRAND,
  FABRIC_PRIMITIVE_BRAND,
  MERGEABLE_OP_METHODS,
} from "@commonfabric/api";

// The schema `type` vocabulary of the primitive classes, which
// `@commonfabric/api` declares and the data model implements. The real surface
// binds these two from there as well.
export {
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  isFabricPrimitiveSchemaType,
} from "@commonfabric/data-model/fabric-primitives";

export function findEventHandlers(
  node: unknown,
  eventName: string,
): Array<() => unknown> {
  const handlers: Array<() => unknown> = [];
  const visit = (value: unknown) => {
    if (value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const props = (value as { props?: Record<string, unknown> }).props;
    const handlerValue = props?.[eventName];
    if (typeof handlerValue === "function") {
      handlers.push(handlerValue as () => unknown);
    } else if (
      handlerValue &&
      typeof handlerValue === "object" &&
      typeof (handlerValue as { send?: unknown }).send === "function"
    ) {
      handlers.push(() => (handlerValue as Stream<unknown>).send());
    }
    visit((value as { children?: unknown }).children);
    visit(props?.children);
  };
  visit(node);
  return handlers;
}

export function textContent(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "object") {
    const value = node as {
      children?: unknown;
      props?: { children?: unknown };
    };
    return textContent(value.children) + textContent(value.props?.children);
  }
  return "";
}
