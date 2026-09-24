/**
 * The encodable form of a value -- what it becomes on the way to storage --
 * asked for three ways: whether a value has one, what a single value's is, and
 * a walk that replaces every artifact inside a larger value with its own.
 *
 * The walk is the part whose contract is worth stating up front. It rebuilds
 * only what it must, so a subtree holding no artifact comes back by identity,
 * and it reports what it rebuilt rather than leaving a caller to work that out
 * by comparison. What it will not do is decide anything on a value's behalf: a
 * value that already knows how to represent itself is left alone, and a cycle
 * is left for the encoder to reject rather than being broken here.
 */

import type { FabricExecValue } from "@commonfabric/api";
import { isPlainObject } from "@commonfabric/utils/types";

/**
 * Reads the method by which a value produces its encodable form -- the form it
 * takes on the way to being encoded, which reaches storage without ever being
 * stringified.
 *
 * One name is asked for: `toEncodableForm`. Every builder artifact carries it
 * -- a module, a handler, a pattern, and the factory that carries a module's
 * members -- and so does a `Cell`, whose form is the link it names. A cell is
 * what a caller here is likeliest to hold that is not an artifact: a graph
 * feeding a content-derived id or a builder default can carry one, and neither
 * has a representation for the cell itself. The storage boundary is elsewhere
 * and asks differently, recognizing a cell by class rather than by member.
 *
 * Asking by name is what keeps this module below the runtime's core in the
 * import graph, where it cannot name `Cell` as a class. The name being the
 * runtime's own is what keeps the question narrow: nothing outside the runtime
 * has reason to define a member spelled this way, so a value does not acquire
 * an encodable form by carrying one it meant for something else.
 */
function encodableFormMethod(value: unknown): (() => unknown) | undefined {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }

  // Read once and hand back what was read. The member may be accessor-backed,
  // and a second read at the invoke would run that accessor again, so what got
  // serialized would be whatever it produced the second time.
  const method = (value as { toEncodableForm?: unknown }).toEncodableForm;
  return typeof method === "function" ? method as () => unknown : undefined;
}

/**
 * Checks whether a value can produce an encodable form of itself.
 *
 * _Broader_ than the walk's own test (`ownEncodableFormMethod()`), and
 * intentionally: this accepts an _inherited_ member, which is how a cell
 * satisfies it, a class putting its methods on the prototype. The walk requires
 * an own member; see there for what that buys it.
 */
export function hasEncodableForm(value: unknown): boolean {
  return encodableFormMethod(value) !== undefined;
}

/**
 * Produces the encodable form of a value that has one, and the value itself for
 * a value that does not -- so a caller that wants "the form, or this as it
 * stands" asks once. Asking `hasEncodableForm()` first and then calling this
 * reads the member twice, and the member can be accessor-backed.
 *
 * `ifNone` replaces the value as the answer for a value carrying no form, so a
 * caller whose fallback is something else also asks once. Pass `undefined` to
 * stand a computed fallback behind a `??`. Passing it explicitly is not the same
 * as omitting it.
 *
 * A caller that needs to tell a value with no form from one whose form is
 * nullish asks `hasEncodableForm()`, which is the question that distinguishes
 * them.
 */
export function encodableFormOf<T>(value: T): unknown | T;
export function encodableFormOf<F>(value: unknown, ifNone: F): unknown | F;
export function encodableFormOf(
  value: unknown,
  ...ifNone: [] | [unknown]
): unknown {
  const method = encodableFormMethod(value);
  if (method !== undefined) return encodableFormFrom(method, value);
  return ifNone.length === 0 ? value : ifNone[0];
}

/**
 * Helper for `encodableFormOf()` and `replace()`, which returns what an
 * already-read `toEncodableForm` produces, invoked on the value it was read
 * from.
 */
function encodableFormFrom(method: () => unknown, value: unknown): unknown {
  // `Reflect.apply`, and not the method's own `.call`. A proxy answers each
  // property read however it likes, so a proxied function can report `typeof
  // "function"` while what its `.call` yields is not callable at all.
  // `Reflect.apply` reaches a function's call behavior directly rather than
  // reading a property off it, which holds whether the method in hand arrived
  // plain or through a proxy.
  return Reflect.apply(method, value, []);
}

/**
 * Marks an object whose replacement is under way -- an ancestor in the walk --
 * so a cycle is recognized instead of followed forever.
 */
const IN_PROGRESS = Symbol("IN_PROGRESS");

/**
 * Told about each copy the walk makes, so a caller can carry across whatever
 * does not travel with the bytes. Trust and the content-addressed entry ref
 * live in identity-keyed side tables, which is exactly that.
 */
type OnCopy = (copy: unknown, original: unknown) => void;

/**
 * Asked about each object or function the walk neither descends into nor
 * replaces itself, and returns what should stand in its place -- the value
 * itself to leave it alone. This is how a caller says what _else_ has no fabric
 * representation: a `Cell`, whose encodable form is the link it stands for.
 * Recognizing one takes `isCell()`, which lives in the runtime's core, so the
 * knowledge arrives as a function rather than an import.
 */
type ReplaceOther = (value: object | AnyFunction) => unknown;

/**
 * Asked about each container the walk is about to descend into, and answers
 * whether the caller holds it to be a leaf -- a value whose members the walk
 * must not read.
 *
 * A live query-result view is what the hook is for: its members resolve
 * through the transaction behind it as they are asked for, and each read is
 * recorded there as a dependency. A caller supplies this when what receives
 * the result does not read inside such a value either, so the reading would
 * buy nothing. A caller that goes on to serialize the whole value does not,
 * since those members have to be read either way.
 */
type IsLeaf = (value: object) => boolean;

/**
 * The two questions the walk puts to its caller, about values it cannot settle
 * on its own. Each defaults to the answer that leaves the walk to its own
 * judgment.
 */
export type WalkHooks = {
  replaceOther?: ReplaceOther;
  isLeaf?: IsLeaf;
};

/** The same pair with both answers in hand, which is what the walk carries. */
type Hooks = Required<WalkHooks>;

/** Shorthand for the callable shape the walk reaches. */
type AnyFunction = (...args: never[]) => unknown;

/**
 * Replaces every builder artifact reachable from `value` with its encodable
 * form, yielding a value the data model can represent. The hooks are the two
 * questions a caller answers for it (see `WalkHooks`).
 *
 * A builder artifact carries its serializer as a `toEncodableForm` method (see
 * `builder/module.ts` and `builder/pattern.ts`). A method is a function-valued
 * property and a `FabricPlainObject` has none, so an artifact has to be
 * replaced before the value crosses into the data model. An artifact sits
 * wherever a pattern author put it -- under a tool's `handler` key, in a
 * result, inside a node's `inputs` -- so finding one takes a walk.
 *
 * The `toEncodableForm` name is what bounds the subject to _builder artifacts_.
 * An artifact carries `toJSON` as well, delegating to the same serializer (see
 * `builder/json-member.ts`), but that name belongs to `JSON.stringify` and the
 * conversion gives it no standing: a plain object carrying a `toJSON` it
 * defined itself is user data, and the conversion rejects it, that `toJSON`
 * being a function-valued member.
 *
 * An artifact is reached in two shapes and both are covered: a module is an
 * object, and a factory is a _function_ carrying its module's members (the
 * `Object.assign` in `builder/module.ts`). A function is replaced but never
 * descended into: its members are the builder's, not content.
 *
 * Subtrees carrying no artifact come back by identity, which keeps an already
 * deep-frozen `FabricValue` eligible for the conversion's identity fast path
 * and keeps a twice-reachable object shared.
 *
 * A cycle is left for the conversion to reject. What it rejects it _by_ may be
 * the cycle or an artifact still raw inside the partial result: an ancestor is
 * returned as itself, so a copy's cycle edge points at the original.
 *
 * A `FabricExecValue` comes back as one, as long as nothing stands in for a
 * value through `replaceOther`: an artifact's encodable form is itself a
 * `FabricExecValue`, as the `toEncodableForm` protocol's type says, and nothing
 * else changes kind. Any other value comes back as `unknown`, since the walk
 * leaves whatever it does not recognize as it is.
 */
export function replaceArtifacts(
  value: FabricExecValue,
  onCopy: OnCopy,
  hooks?: { isLeaf?: WalkHooks["isLeaf"]; replaceOther?: undefined },
): FabricExecValue;
export function replaceArtifacts(
  value: unknown,
  onCopy: OnCopy,
  hooks?: WalkHooks,
): unknown;
export function replaceArtifacts(
  value: unknown,
  onCopy: OnCopy,
  hooks: WalkHooks = {},
): unknown {
  return replace(value, new Map(), onCopy, {
    replaceOther: hooks.replaceOther ?? ((value) => value),
    isLeaf: hooks.isLeaf ?? (() => false),
  });
}

/**
 * Helper for `replaceArtifacts()`, which carries the walk over one value and
 * returns what should stand in its place -- the value itself when nothing under
 * it moved.
 *
 * `seen` doubles as the cycle guard and the record of what each value was
 * replaced by, so a value reachable twice is replaced once. It comes back as
 * the same object both times, except across a cycle edge: an ancestor still
 * under way comes back as itself, which is what the guard is for.
 */
function replace(
  value: unknown,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
  hooks: Hooks,
): unknown {
  if (value === null) return value;
  const isFunction = typeof value === "function";
  if (!isFunction && typeof value !== "object") return value;

  if (seen.has(value)) {
    const flattened = seen.get(value);
    return flattened === IN_PROGRESS ? value : flattened;
  }

  // A factory is a function carrying its module's members. Replaced by its
  // encodable form, never descended into: a function's own members belong to
  // the builder, and a function that is not an artifact has no fabric
  // representation for the conversion to find either way.
  if (isFunction) {
    const method = ownEncodableFormMethod(value);
    if (method === undefined) {
      return replaced(value, hooks, seen, onCopy);
    }
    seen.set(value, IN_PROGRESS);
    return copied(
      replace(encodableFormFrom(method, value), seen, onCopy, hooks),
      value,
      seen,
      onCopy,
    );
  }

  // A value the caller holds to be a leaf is settled ahead of the shape
  // questions below, whatever shape it reports. It still goes to
  // `replaceOther`, which is what stands something in its place.
  if (hooks.isLeaf(value)) {
    return replaced(value, hooks, seen, onCopy);
  }

  // The array rule applies whatever an array carries, so an array is only ever
  // descended into.
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value, false)) {
    // Anything else -- a `FabricInstance`, a `Date` -- carries no builder
    // artifact, and is the conversion's to interpret unless `replaceOther`
    // claims it. A `Cell` is what that hook is for: the walk cannot name one
    // from here, and the conversion has no representation for it either.
    //
    // A null-prototype object is excluded too -- hence the `false` argument to
    // `isPlainObject()`. It is not a `FabricPlainObject`, so it is not the
    // walk's to rewrite. That is not the same as the conversion refusing one:
    // `tagOfConvertibleJsValueElseNull()` reports it as `Object`. Whether to
    // accept it is the conversion's question, asked of the value as it stands.
    return replaced(value, hooks, seen, onCopy);
  }

  seen.set(value, IN_PROGRESS);
  let flattened: unknown;
  if (isArray) {
    flattened = replaceInElements(value, seen, onCopy, hooks);
  } else {
    // The artifact's _own_ method is what gets read and called, rather than the
    // serializer it delegates to: the method a copy carries is closed over the
    // artifact the copy was made from, and that original is what the
    // serialized form describes.
    const method = ownEncodableFormMethod(value);
    flattened = method === undefined
      ? replaceInEntries(
        value as Record<string, unknown>,
        seen,
        onCopy,
        hooks,
      )
      : replace(encodableFormFrom(method, value), seen, onCopy, hooks);
  }
  return copied(flattened, value, seen, onCopy);
}

/**
 * Helper for `replace()`, which offers a value the walk does not descend into
 * to `replaceOther` and records whatever comes back.
 *
 * The replacement is _not_ descended into: what the hook returns stands for the
 * value itself -- a link, say -- and only a container gets descended into.
 */
function replaced(
  value: object | AnyFunction,
  hooks: Hooks,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
): unknown {
  const replacement = hooks.replaceOther(value);
  if (replacement === value) return value;
  return copied(replacement, value, seen, onCopy);
}

/**
 * Records a replacement: the single place a copy becomes the replacement for
 * its original.
 *
 * Every branch that replaces a value returns through here, which is what makes
 * a copy's bookkeeping unforgettable: the caller is told, so identity-keyed
 * facts can follow the copy, and the replacement is remembered, so a value
 * reachable twice is replaced once.
 *
 * A value that came back unchanged is not a copy and is not announced as one.
 */
function copied(
  replacement: unknown,
  original: object,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
): unknown {
  if (replacement !== original) onCopy(replacement, original);
  seen.set(original, replacement);
  return replacement;
}

/**
 * Helper for `replace()`, which walks an array's elements and returns the array
 * itself when none of them moved.
 *
 * Holes stay holes: an absent element is not read, so nothing fills it in.
 */
function replaceInElements(
  value: readonly unknown[],
  seen: Map<object, unknown>,
  onCopy: OnCopy,
  hooks: Hooks,
): readonly unknown[] {
  // Read each element _once_, and build any copy from what was read -- the
  // array counterpart of the entries `replaceInEntries` materializes, for the
  // same reason. Copying by re-reading (`slice()`, or an index-by-index pass
  // over the original) runs an accessor-backed element a second time and
  // keeps _that_ value, storing a value the array never held at any single
  // moment and which the walk never inspected.
  //
  // So the result is built as it goes rather than cloned at the first change:
  // every element is written here, changed or not, and the original is
  // returned by identity unless something actually moved.
  const replaced: unknown[] = [];
  replaced.length = value.length;
  let changed = false;
  for (let i = 0; i < value.length; i++) {
    // A hole holds nothing to flatten, and reading one would report the
    // element as `undefined` and fill it in on the copy. Skipped, so it stays
    // a hole here too.
    if (!(i in value)) continue;
    const element = value[i];
    const flattened = replace(element, seen, onCopy, hooks);
    replaced[i] = flattened;
    if (flattened !== element) changed = true;
  }
  return changed ? replaced : value;
}

/**
 * Helper for `replace()`, which walks a record's members and returns the record
 * itself when none of them moved.
 */
function replaceInEntries(
  value: Record<string, unknown>,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
  hooks: Hooks,
): Record<string, unknown> {
  // Read each member _once_, and build any copy from what was read: reading a
  // second time to copy would run an accessor twice and keep the second
  // value, so a value whose members are accessor-backed would be recorded
  // as something it never was at any single moment.
  const entries = Object.entries(value);
  let result: Record<string, unknown> | undefined;
  for (let i = 0; i < entries.length; i++) {
    const [key, element] = entries[i];
    const flattened = replace(element, seen, onCopy, hooks);
    if (flattened === element) continue;
    result ??= Object.fromEntries(entries);
    result[key] = flattened;
  }
  return result ?? value;
}

/**
 * Helper for `replace()`, which returns a value's own callable
 * `toEncodableForm` method, or `undefined` when it has none. This is the walk's
 * test for "this is a builder artifact" and the source of the method it
 * invokes, in one result: the function returned is the one that gets called.
 *
 * A `Cell` never reaches this question. It carries the member on its class,
 * which own-ness would exclude anyway, but `replace()` stops short of here with
 * one: a cell is not a plain object, so it goes to the `replaceOther` hook,
 * whose caller can name one.
 */
function ownEncodableFormMethod(
  value: object | ((...args: unknown[]) => unknown),
): (() => unknown) | undefined {
  // _Own_, not inherited: an inherited member is not the value's own
  // serializer, and a single assignment to `Object.prototype.toEncodableForm`
  // would otherwise route every plain object in the process through here.
  if (!Object.hasOwn(value, "toEncodableForm")) return undefined;

  // Read once, and hand back what was read. `Object.hasOwn()` runs no accessor,
  // so this is the only read; an accessor-backed member asked again at the
  // invoke would run a second time, and its second result is what would get
  // serialized.
  const method = (value as { toEncodableForm: unknown }).toEncodableForm;

  // The `typeof` gate is what settles a value carrying a user-data key of the
  // name -- a query-result proxy satisfies `Object.hasOwn()` for any key its
  // record holds -- since a `FabricPlainObject` has no function-valued member
  // to find.
  return typeof method === "function" ? method as () => unknown : undefined;
}
