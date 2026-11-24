/**
 * The scope instances of the documents of an executor, and the memo
 * entries that were evaluated for one of them
 * (`execution-and-storage.md` §1.8 and §4.1).
 *
 * A document of the scope `user` or `session` has one instance for each
 * principal, or each session of a principal. The executor names such a
 * document by one text for every principal, which ends in the name of the
 * scope: a reference to it stored in a document of the space is the same
 * for every reader. Whoever runs the executor says which principal and
 * session an evaluation is for (`ScopeInstancesOptions.keyOf`), and the
 * store then holds, reads and writes the instance of that key.
 *
 * A memo entry whose evaluation read or wrote a scope instance, or used
 * an entry that did, is of that scope key, and no other key is given its
 * value: the entries of the keys that are not being evaluated for are
 * set aside by key and brought back when their key is evaluated for
 * again. An entry that touched no scope instance is one for every key.
 */

/** A scope narrower than the space. */
export type Scope = "user" | "session";

/** What stands between the name of a document and the scope it is of. */
const OF = "~";

const SCOPES: readonly Scope[] = ["user", "session"];

/** Whether `a` is narrower than `b`, where `undefined` is the space. */
export const narrowerThan = (a: Scope, b: Scope | undefined): boolean =>
  b === undefined || (a === "session" && b === "user");

/** The name of the instances of `doc` in `scope`, for every scope key. */
export const scopedDocument = (doc: string, scope: Scope): string =>
  `${doc}${OF}${scope}`;

/**
 * What the name of a document says of its scope: the name without the
 * scope, the scope where it names one, and the scope key where it names
 * the instance of one key.
 */
export const scopeOfDocument = (
  doc: string,
): { base: string; scope?: Scope; key?: string } => {
  const at = doc.lastIndexOf(OF);
  if (at < 0) return { base: doc };
  const rest = doc.slice(at + OF.length);
  for (const scope of SCOPES) {
    if (rest === scope) return { base: doc.slice(0, at), scope };
    if (rest.startsWith(`${scope}:`)) {
      return { base: doc.slice(0, at), scope, key: rest };
    }
  }
  return { base: doc };
};

/** The scope a scope key is of. */
export const scopeOfKey = (key: string): Scope =>
  key.startsWith("session:") ? "session" : "user";

/** What `ScopeInstances` takes. */
export type ScopeInstancesOptions = {
  /**
   * The scope key the evaluation in progress is for, in `scope`:
   * `user:<principal>`, or `session:<principal>:<session>`. Called for
   * each access of a scope instance.
   */
  keyOf: (scope: Scope) => string;
};

/** What an evaluation touched of scope instances, the narrowest scope. */
type Frame = { scope?: Scope };

/** A memo entry as this module reads it. */
type ScopedEntry = { scoped?: string; stale?: boolean };

/**
 * The scope keys an executor evaluates for: which instance a name of a
 * scoped document stands for now, what each evaluation in progress
 * touched, and the entries set aside for the keys not evaluated for.
 */
export class ScopeInstances {
  readonly #options: ScopeInstancesOptions;
  /** The evaluations in progress, innermost last. */
  readonly #frames: Frame[] = [];
  /** The entries set aside, by the name of the entry and the scope key. */
  readonly #aside = new Map<string, Map<string, ScopedEntry>>();
  /** The narrowest scope each name of an entry was found to have. */
  readonly #narrowed = new Map<string, Scope>();

  /** Constructs an instance that asks `options.keyOf` for the scope keys. */
  constructor(options: ScopeInstancesOptions) {
    this.#options = options;
  }

  /** The scope key that is evaluated for in `scope`. */
  keyOf(scope: Scope): string {
    return this.#options.keyOf(scope);
  }

  /**
   * The name of the instance that `doc` stands for now: `doc` itself
   * where it names no scope or the instance of one key. The evaluation in
   * progress is then one that touched the scope.
   */
  resolve(doc: string): string {
    // The names of most documents hold no scope.
    if (doc.indexOf(OF) < 0) return doc;
    const { base, scope, key } = scopeOfDocument(doc);
    if (scope === undefined || key !== undefined) return doc;
    this.touch(scope);
    return `${base}${OF}${this.keyOf(scope)}`;
  }

  /** Notes that the evaluation in progress touched `scope`. */
  touch(scope: Scope): void {
    const top = this.#frames[this.#frames.length - 1];
    if (top !== undefined && narrowerThan(scope, top.scope)) top.scope = scope;
  }

  /**
   * Runs `run` as an evaluation of its own, and returns what it gave with
   * the narrowest scope it touched. What it touched is no touch of the
   * evaluation around it.
   */
  framed<T>(run: () => T): { value: T; scope: Scope | undefined } {
    const frame: Frame = {};
    this.#frames.push(frame);
    try {
      return { value: run(), scope: frame.scope };
    } finally {
      this.#frames.pop();
    }
  }

  /** The narrowest scope the evaluation in progress touched so far. */
  get touched(): Scope | undefined {
    return this.#frames[this.#frames.length - 1]?.scope;
  }

  /** Whether an entry of the scope key `scoped` is of a key evaluated for. */
  acting(scoped: string): boolean {
    return this.keyOf(scopeOfKey(scoped)) === scoped;
  }

  /** The narrowest scope the entry `name` was found to have. */
  narrowed(name: string): Scope | undefined {
    return this.#narrowed.get(name);
  }

  /**
   * Notes that the entry `name` has the scope `scope`. Returns whether
   * that is narrower than what was known of it.
   */
  narrow(name: string, scope: Scope): boolean {
    if (!narrowerThan(scope, this.#narrowed.get(name))) return false;
    this.#narrowed.set(name, scope);
    return true;
  }

  /** Sets the entry `entry` of `name` aside under its scope key. */
  setAside(name: string, entry: ScopedEntry): void {
    if (entry.scoped === undefined) return;
    let held = this.#aside.get(name);
    if (held === undefined) {
      held = new Map();
      this.#aside.set(name, held);
    }
    held.set(entry.scoped, entry);
  }

  /**
   * Takes back the entry of `name` that was set aside for a key that is
   * evaluated for now, the session's before the user's.
   */
  takeBack<T extends ScopedEntry>(name: string): T | undefined {
    const held = this.#aside.get(name);
    if (held === undefined) return undefined;
    for (const scope of ["session", "user"] as const) {
      const entry = held.get(this.keyOf(scope));
      if (entry === undefined) continue;
      held.delete(entry.scoped!);
      return entry as T;
    }
    return undefined;
  }

  /**
   * Marks the entries of `name` that are set aside as not current: all of
   * them, or those of the scope keys `of` accepts.
   */
  staleAside(name: string, of?: (key: string) => boolean): void {
    for (const [scoped, entry] of this.#aside.get(name) ?? []) {
      if (of === undefined || of(scoped)) entry.stale = true;
    }
  }

  /** Forgets the entries of `name` that are set aside. */
  forget(name: string): void {
    this.#aside.delete(name);
  }

  /** How many entries are set aside, for every name and key. */
  get asideCount(): number {
    let count = 0;
    for (const held of this.#aside.values()) count += held.size;
    return count;
  }
}
