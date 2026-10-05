import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  authorClaimLabel,
  type AuthorshipObservation,
  authorshipStateForLabel,
  integrityAtomMatchesAuthor,
  observeAuthorship,
  type ObserveAuthorshipOptions,
} from "@/authorship.ts";
import { CellReadRefusedError } from "@/cell-handle.ts";

/** A label whose root says its value was written by `sender`. */
const authoredByLabel = (sender: string) => ({
  version: 1 as const,
  entries: [{
    path: [],
    label: { integrity: [{ kind: "authored-by", subject: sender }] },
  }],
});

/**
 * The label read through a message's link to a profile owned by `owner`: the
 * message's `authored-by` for `sender` at the root, and the owner's
 * `represents-principal` on each of the profile's owner-protected fields.
 */
const linkedProfileLabel = (sender: string, owner: string) => ({
  version: 1 as const,
  entries: [
    ...authoredByLabel(sender).entries,
    ...["avatar", "bio", "name"].map((field) => ({
      path: [field],
      label: { integrity: [{ kind: "represents-principal", subject: owner }] },
    })),
  ],
});

/** A label whose root says its value represents the principal `owner`. */
const representsLabel = (owner: string) => ({
  version: 1 as const,
  entries: [{
    path: [],
    label: { integrity: [{ kind: "represents-principal", subject: owner }] },
  }],
});

/**
 * Lets every read the observation has started finish: the fakes here answer
 * through settled promises, so one zero-delay turn runs them all.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A resolved cell whose document has not loaded: its label reads as missing
 * until `load()` delivers one to its subscribers, as the runtime does with an
 * update when the document arrives. Given `id`, it names that cell in its
 * `ref()`, as a runtime cell handle does.
 */
const unloadedCell = (id?: string) => {
  let label: unknown;
  const subscribers = new Set<
    (value: unknown, cfcLabel?: unknown) => void
  >();
  const refusals = new Set<(refusal: unknown) => void>();
  const options: ({ includeCfcLabel?: boolean } | undefined)[] = [];
  return {
    ...(id === undefined
      ? {}
      : { ref: () => ({ space: "did:example:space", id, path: [] }) }),
    getCfcLabel: () => Promise.resolve(label),
    subscribe(
      callback: (value: unknown, cfcLabel?: unknown) => void,
      subscribeOptions?: {
        includeCfcLabel?: boolean;
        onRefused?: (refusal: unknown) => void;
      },
    ) {
      subscribers.add(callback);
      const onRefused = subscribeOptions?.onRefused;
      if (onRefused !== undefined) refusals.add(onRefused);
      options.push(subscribeOptions);
      callback(undefined, label);
      return () => {
        subscribers.delete(callback);
        if (onRefused !== undefined) refusals.delete(onRefused);
      };
    },
    subscriberCount: () => subscribers.size,

    /** How many times anything has subscribed. */
    subscribeCalls: () => options.length,

    /** Whether every subscription asked for its updates to carry labels. */
    allAskedForLabels: () =>
      options.length > 0 &&
      options.every((option) => option?.includeCfcLabel === true),

    /** Delivers `next` as the label, and settles the reads it starts. */
    async load(next: unknown) {
      label = next;
      for (const callback of [...subscribers]) {
        callback({ loaded: true }, label);
      }
      await settle();
    },

    /**
     * Stores `next` as the label (`undefined` for a document with none) and
     * delivers the value without it, as an update on a subscription that
     * does not carry labels does; settles the reads it starts.
     */
    async loadWithoutDeliveringLabel(next: unknown) {
      label = next;
      for (const callback of [...subscribers]) {
        callback({ loaded: true }, undefined);
      }
      await settle();
    },

    /** Refuses the cell's read to every subscriber, as the worker does. */
    refuse() {
      for (const onRefused of [...refusals]) {
        onRefused({ refusedBy: "display-ceiling" });
      }
    },
  };
};

/**
 * A value cell whose own label reads as missing and which resolves to
 * whatever `resolveTo()` names at the time; `update()` delivers a new value to
 * its subscribers, as the runtime does when the cell changes.
 */
const valueCell = (resolveTo: () => unknown) => {
  const subscribers = new Set<() => void>();
  return {
    getCfcLabel: () => Promise.resolve(undefined),
    resolveAsCell: () => Promise.resolve(resolveTo()),
    subscribe(callback: () => void) {
      subscribers.add(callback);
      callback();
      return () => {
        subscribers.delete(callback);
      };
    },

    /** Delivers an update, and settles the reads it starts. */
    async update() {
      for (const callback of [...subscribers]) callback();
      await settle();
    },
  };
};

/**
 * Observes `value` and `author`, keeping every report the observation makes.
 */
const observe = (
  value: unknown,
  author: unknown,
  options?: ObserveAuthorshipOptions,
) => {
  const reports: AuthorshipObservation[] = [];
  const cancel = observeAuthorship(
    value,
    author,
    (observation) => reports.push(observation),
    options,
  );
  return {
    reports,
    cancel,

    /** Every verdict reported, in order. */
    states: () => reports.map((report) => report.state),

    /** The latest verdict, or `undefined` before the first report. */
    get state() {
      return reports.at(-1)?.state;
    },

    /** The latest author claim, or `undefined` before the first report. */
    get authorClaim() {
      return reports.at(-1)?.authorClaim;
    },
  };
};

describe("authorship", () => {
  describe("observeAuthorship()", () => {
    it("reports `verified` when the value's root label names the claimed author", async () => {
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
        "alice",
      );
      await settle();

      expect(observation.states()).toEqual(["verified"]);
    });

    it("reports `unverified` when the value's root label names another author", async () => {
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
        "bob",
      );
      await settle();

      expect(observation.states()).toEqual(["unverified"]);
    });

    it("reports `unknown` once a value with no label has loaded", async () => {
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(undefined) },
        "alice",
      );
      await settle();

      expect(observation.states()).toEqual(["unknown"]);
    });

    it("reports a plain author as its own claim", async () => {
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
        "alice",
      );
      await settle();

      expect(observation.authorClaim).toBe("alice");
    });

    it("falls back to the resolved cell label for bound prop cells", async () => {
      const observation = observe({
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () =>
          Promise.resolve({
            getCfcLabel: () => Promise.resolve(authoredByLabel("alice")),
          }),
      }, "alice");
      await settle();

      expect(observation.state).toBe("verified");
    });

    it("reports nothing while the value's resolved cell has not loaded, and `verified` once it delivers its label", async () => {
      // A resolved cell whose document has not loaded reads as having no
      // label. The observation subscribes to that cell and re-reads on the
      // update that carries its label, and reports no verdict before then.
      const resolved = unloadedCell();
      const observation = observe({
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      }, "alice");

      try {
        await settle();
        expect(resolved.subscriberCount()).toBe(1);
        expect(resolved.allAskedForLabels()).toBe(true);
        expect(observation.states()).toEqual([]);

        await resolved.load(authoredByLabel("alice"));

        expect(observation.states()).toEqual(["verified"]);
        expect(resolved.subscriberCount()).toBe(0);
      } finally {
        observation.cancel();
      }
    });

    it("reports nothing while the author's resolved cell has not loaded, and `verified` once it delivers its label", async () => {
      const resolved = unloadedCell();
      const observation = observe(
        {
          getCfcLabel: () =>
            Promise.resolve(authoredByLabel("did:example:alice")),
        },
        {
          get: () => ({ name: "Alice" }),
          getCfcLabel: () => Promise.resolve(undefined),
          resolveAsCell: () => Promise.resolve(resolved),
        },
      );

      try {
        await settle();
        expect(resolved.allAskedForLabels()).toBe(true);
        expect(observation.states()).toEqual([]);

        await resolved.load(
          linkedProfileLabel("did:example:alice", "did:example:alice"),
        );

        expect(observation.states()).toEqual(["verified"]);
        expect(resolved.subscriberCount()).toBe(0);
      } finally {
        observation.cancel();
      }
    });

    it("reads the author's resolved label past a principal a link carried", async () => {
      // A slot holding a link carries the linked document's atoms as
      // `followRef` entries; they name no principal here, so the resolved
      // cell is read.
      const resolved = unloadedCell();
      const observation = observe(
        {
          getCfcLabel: () =>
            Promise.resolve(authoredByLabel("did:example:alice")),
        },
        {
          get: () => ({ name: "Alice" }),
          getCfcLabel: () =>
            Promise.resolve({
              version: 1 as const,
              entries: [{
                path: [],
                label: {
                  integrity: [{
                    kind: "represents-principal",
                    subject: "did:example:bob",
                  }],
                },
                observes: "followRef" as const,
              }],
            }),
          resolveAsCell: () => Promise.resolve(resolved),
        },
      );

      try {
        await settle();
        expect(resolved.allAskedForLabels()).toBe(true);

        await resolved.load(
          linkedProfileLabel("did:example:alice", "did:example:alice"),
        );

        expect(observation.state).toBe("verified");
      } finally {
        observation.cancel();
      }
    });

    it("keeps one watch across reads while the resolved cell is unloaded", async () => {
      const resolved = unloadedCell();
      const value = valueCell(() => resolved);
      const observation = observe(value, "alice");

      try {
        await settle();
        await value.update();
        expect(resolved.subscriberCount()).toBe(1);
        expect(resolved.subscribeCalls()).toBe(1);

        await resolved.load(authoredByLabel("alice"));

        expect(resolved.subscriberCount()).toBe(0);
      } finally {
        observation.cancel();
      }
    });

    it("reports `unknown` once a resolved cell loads with no label, and stops watching it", async () => {
      const resolved = unloadedCell();
      const observation = observe({
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      }, "alice");

      try {
        await settle();
        expect(resolved.subscriberCount()).toBe(1);

        await resolved.loadWithoutDeliveringLabel(undefined);

        expect(resolved.subscriberCount()).toBe(0);
        expect(observation.states()).toEqual(["unknown"]);
      } finally {
        observation.cancel();
      }
    });

    it("re-reads the label when an update brings the value without it", async () => {
      // A subscription that is not the first on its backend key may carry no
      // labels, so the label is read from the store once the value arrives.
      const resolved = unloadedCell();
      const observation = observe({
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      }, "alice");

      try {
        await settle();
        expect(observation.states()).toEqual([]);

        await resolved.loadWithoutDeliveringLabel(authoredByLabel("alice"));

        expect(observation.states()).toEqual(["verified"]);
        expect(resolved.subscriberCount()).toBe(0);
      } finally {
        observation.cancel();
      }
    });

    it("moves the watch between resolved cells that have no ref", async () => {
      const first = unloadedCell();
      const second = unloadedCell();
      let resolved = first;
      const value = valueCell(() => resolved);
      const observation = observe(value, "alice");

      try {
        await settle();
        expect(first.subscriberCount()).toBe(1);

        resolved = second;
        await value.update();

        expect(first.subscriberCount()).toBe(0);
        expect(second.subscriberCount()).toBe(1);
      } finally {
        observation.cancel();
      }
    });

    it("moves the watch when the source resolves to a different cell", async () => {
      const first = unloadedCell("first");
      const second = unloadedCell("second");
      let resolved = first;
      const value = valueCell(() => resolved);
      const observation = observe(value, "alice");

      try {
        await settle();
        expect(first.subscriberCount()).toBe(1);

        resolved = second;
        await value.update();

        expect(first.subscriberCount()).toBe(0);
        expect(second.subscriberCount()).toBe(1);
      } finally {
        observation.cancel();
      }
    });

    it("stops watching the resolved cell, and reports `unknown`, once the worker refuses the value", async () => {
      const resolved = unloadedCell();
      let refuse: (() => void) | undefined;
      const observation = observe({
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
        subscribe: (
          callback: () => void,
          options: { onRefused: (refusal: unknown) => void },
        ) => {
          refuse = () => options.onRefused({ refusedBy: "display-ceiling" });
          callback();
          return () => {};
        },
      }, "alice");

      try {
        await settle();
        expect(resolved.subscriberCount()).toBe(1);

        refuse?.();

        expect(resolved.subscriberCount()).toBe(0);
        expect(observation.states()).toEqual(["unknown"]);
      } finally {
        observation.cancel();
      }
    });

    it("reports `unknown` once the worker refuses the watched resolved cell", async () => {
      const resolved = unloadedCell();
      const observation = observe({
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      }, "alice");

      try {
        await settle();
        expect(observation.states()).toEqual([]);

        resolved.refuse();

        expect(resolved.subscriberCount()).toBe(0);
        expect(observation.states()).toEqual(["unknown"]);
      } finally {
        observation.cancel();
      }
    });

    it("stops watching an unloaded resolved cell, and reports nothing more, once cancelled", async () => {
      const resolved = unloadedCell();
      const observation = observe({
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      }, "alice");

      await settle();
      expect(resolved.subscriberCount()).toBe(1);

      observation.cancel();

      expect(resolved.subscriberCount()).toBe(0);
      await resolved.load(authoredByLabel("alice"));
      expect(observation.states()).toEqual([]);
    });

    it("reports again when the value's label changes", async () => {
      let label = authoredByLabel("alice");
      const subscribers = new Set<() => void>();
      const observation = observe({
        getCfcLabel: () => Promise.resolve(label),
        subscribe(callback: () => void) {
          subscribers.add(callback);
          callback();
          return () => subscribers.delete(callback);
        },
      }, "alice");

      try {
        await settle();
        expect(observation.states()).toEqual(["verified"]);

        label = authoredByLabel("mallory");
        for (const callback of [...subscribers]) callback();
        await settle();

        expect(observation.states()).toEqual(["verified", "unverified"]);
      } finally {
        observation.cancel();
      }
    });

    it("reports again when the author's label changes", async () => {
      let label = representsLabel("did:example:alice");
      const subscribers = new Set<() => void>();
      const observation = observe(
        {
          getCfcLabel: () =>
            Promise.resolve(authoredByLabel("did:example:alice")),
        },
        {
          get: () => ({ name: "Alice" }),
          getCfcLabel: () => Promise.resolve(label),
          subscribe(callback: () => void) {
            subscribers.add(callback);
            callback();
            return () => subscribers.delete(callback);
          },
        },
      );

      try {
        await settle();
        expect(observation.states()).toEqual(["verified"]);

        label = representsLabel("did:example:bob");
        for (const callback of [...subscribers]) callback();
        await settle();

        expect(observation.states()).toEqual(["verified", "unverified"]);
      } finally {
        observation.cancel();
      }
    });

    it("uses resolved root authorship when the direct label only has nested entries", async () => {
      const observation = observe({
        getCfcLabel: () =>
          Promise.resolve({
            version: 1 as const,
            entries: [{
              path: ["argument", "element"],
              label: {
                integrity: [{ kind: "authored-by", subject: "alice" }],
              },
            }],
          }),
        resolveAsCell: () =>
          Promise.resolve({
            getCfcLabel: () => Promise.resolve(authoredByLabel("alice")),
          }),
      }, "alice");
      await settle();

      expect(observation.state).toBe("verified");
    });

    it("does not resolve when the direct root label already verifies authorship", async () => {
      const observation = observe({
        getCfcLabel: () => Promise.resolve(authoredByLabel("alice")),
        resolveAsCell: () => {
          throw new Error("direct root label should avoid resolution");
        },
      }, "alice");
      await settle();

      expect(observation.state).toBe("verified");
    });

    it("does not let resolved authorship override direct root authorship", async () => {
      const observation = observe({
        getCfcLabel: () => Promise.resolve(authoredByLabel("bob")),
        resolveAsCell: () =>
          Promise.resolve({
            getCfcLabel: () => Promise.resolve(authoredByLabel("alice")),
          }),
      }, "alice");
      await settle();

      expect(observation.state).toBe("unverified");
    });

    it("verifies object-shaped bound author claims by id", async () => {
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
        {
          get: () => ({ id: "alice", name: "Alice Nguyen" }),
          sync: () => Promise.resolve({ id: "alice", name: "Alice Nguyen" }),
          subscribe: () => () => {},
        },
      );
      await settle();

      expect(observation.state).toBe("verified");
    });

    it("verifies author cells whose sync returns the cell object", async () => {
      const authorCell = {
        get: () => ({ id: "alice", name: "Alice Nguyen" }),
        sync: () => Promise.resolve(authorCell),
        subscribe: () => () => {},
      };
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
        authorCell,
      );
      await settle();

      expect(observation.state).toBe("verified");
    });

    it("verifies resolved author cells that need sync before get", async () => {
      let synced = false;
      const resolvedAuthorCell = {
        get: () => synced ? { id: "alice", name: "Alice Nguyen" } : undefined,
        sync: () => {
          synced = true;
          return Promise.resolve(resolvedAuthorCell);
        },
      };
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
        {
          get: () => undefined,
          sync: () => Promise.resolve({ opaqueCellHandle: true }),
          resolveAsCell: () => resolvedAuthorCell,
          subscribe: () => () => {},
        },
      );
      await settle();

      expect(observation.state).toBe("verified");
    });

    it("verifies a message against a represented-principal profile cell, and follows its name", async () => {
      let profile = { name: "Alice Nguyen" };
      let notify: (() => void) | undefined;
      const observation = observe(
        {
          getCfcLabel: () =>
            Promise.resolve(authoredByLabel("did:example:alice")),
        },
        {
          get: () => profile,
          getCfcLabel: () =>
            Promise.resolve(representsLabel("did:example:alice")),
          subscribe: (callback: () => void) => {
            notify = callback;
            return () => {};
          },
        },
      );
      await settle();

      expect(observation.state).toBe("verified");

      profile = { name: "Alice Updated" };
      notify?.();
      await settle();

      expect(observation.state).toBe("verified");
      expect(observation.authorClaim).toEqual({
        subject: "did:example:alice",
        name: "Alice Updated",
      });
    });

    it("names a principal claim by `authorName` when the author cell holds no name", async () => {
      const observation = observe(
        {
          getCfcLabel: () =>
            Promise.resolve(authoredByLabel("did:example:alice")),
        },
        {
          getCfcLabel: () =>
            Promise.resolve(representsLabel("did:example:alice")),
        },
        { authorName: "Alice Snapshot" },
      );
      await settle();

      expect(observation.state).toBe("verified");
      expect(observation.authorClaim).toEqual({
        subject: "did:example:alice",
        name: "Alice Snapshot",
      });
    });

    it("derives a represented-principal claim from a resolved author label", async () => {
      const observation = observe(
        {
          getCfcLabel: () =>
            Promise.resolve(authoredByLabel("did:example:alice")),
        },
        {
          get: () => ({ name: "Alice Snapshot" }),
          getCfcLabel: () =>
            Promise.resolve({
              version: 1 as const,
              entries: [{
                path: ["profile"],
                label: {
                  integrity: [{
                    kind: "represents-principal",
                    subject: "did:example:alice",
                  }],
                },
              }],
            }),
          resolveAsCell: () =>
            Promise.resolve({
              getCfcLabel: () =>
                Promise.resolve(representsLabel("did:example:alice")),
            }),
        },
      );
      await settle();

      expect(observation.state).toBe("verified");
      expect(observation.authorClaim).toEqual({
        subject: "did:example:alice",
        name: "Alice Snapshot",
      });
    });

    it("verifies a message against a profile whose principal is on its fields", async () => {
      const observation = observe(
        {
          getCfcLabel: () =>
            Promise.resolve(authoredByLabel("did:example:alice")),
        },
        {
          get: () => ({ name: "Alice" }),
          getCfcLabel: () =>
            Promise.resolve(
              linkedProfileLabel("did:example:alice", "did:example:alice"),
            ),
        },
      );
      await settle();

      expect(observation.state).toBe("verified");
      expect(observation.authorClaim).toEqual({
        subject: "did:example:alice",
        name: "Alice",
      });
    });

    it("reports `unverified` when the linked profile's owner did not send the message", async () => {
      const observation = observe(
        {
          getCfcLabel: () =>
            Promise.resolve(authoredByLabel("did:example:mallory")),
        },
        {
          get: () => ({ name: "Alice" }),
          getCfcLabel: () =>
            Promise.resolve(
              linkedProfileLabel("did:example:mallory", "did:example:alice"),
            ),
        },
      );
      await settle();

      expect(observation.state).toBe("unverified");
    });

    it("does not verify on the claim's own id when the profile's label names two principals", async () => {
      // Without the label's principal, the observation would read an author
      // id from the claim's value, which here names the sender.
      const observation = observe(
        {
          getCfcLabel: () =>
            Promise.resolve(authoredByLabel("did:example:mallory")),
        },
        {
          get: () => ({ id: "did:example:mallory", name: "Alice" }),
          getCfcLabel: () =>
            Promise.resolve({
              version: 1 as const,
              entries: [
                ...authoredByLabel("did:example:mallory").entries,
                {
                  path: ["name"],
                  label: {
                    integrity: [{
                      kind: "represents-principal",
                      subject: "did:example:alice",
                    }],
                  },
                },
                {
                  path: ["avatar"],
                  label: {
                    integrity: [{
                      kind: "represents-principal",
                      subject: "did:example:bob",
                    }],
                  },
                },
              ],
            }),
        },
      );
      await settle();

      expect(observation.authorClaim).toBeUndefined();
      expect(observation.state).toBe("unknown");
    });

    it("fails closed when a bound author claim cell changes away from the integrity subject", async () => {
      let author = { id: "alice", name: "Alice Nguyen" };
      let notify: ((value: unknown) => void) | undefined;
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
        {
          get: () => author,
          sync: () => Promise.resolve(author),
          subscribe: (callback: (value: unknown) => void) => {
            notify = callback;
            callback(author);
            return () => {};
          },
        },
      );
      await settle();
      expect(observation.state).toBe("verified");

      author = { id: "bob", name: "Bob Patel" };
      notify?.(author);

      expect(observation.state).toBe("unverified");
    });

    it("does not verify on an authorship atom a link carried to the root", async () => {
      const observation = observe({
        getCfcLabel: () =>
          Promise.resolve({
            version: 1 as const,
            entries: [{
              path: [],
              label: {
                integrity: [{ kind: "authored-by", subject: "alice" }],
              },
              observes: "followRef" as const,
            }],
          }),
      }, "alice");
      await settle();

      expect(observation.states()).toEqual(["unknown"]);
    });

    it("reports `unknown` once a resolved cell that holds nothing answers a read", async () => {
      // The connection delivers no update for a cell that holds nothing, so
      // only a read the observation asks for shows that it has loaded.
      let read = false;
      const subscribers = new Set<
        (value: unknown, cfcLabel?: unknown) => void
      >();
      const resolved = {
        getCfcLabel: () => Promise.resolve(undefined),
        subscribe(callback: (value: unknown, cfcLabel?: unknown) => void) {
          subscribers.add(callback);
          callback(undefined, undefined);
          return () => {
            subscribers.delete(callback);
          };
        },
        lastRead: () => read ? { value: undefined } : { unread: true },
        sync() {
          read = true;
          for (const callback of [...subscribers]) callback(undefined);
          return Promise.resolve(undefined);
        },
      };
      const observation = observe({
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      }, "alice");

      try {
        await settle();

        expect(observation.states()).toEqual(["unknown"]);
        expect(subscribers.size).toBe(0);
      } finally {
        observation.cancel();
      }
    });

    it("reports nothing for an author whose read fails other than by refusal", async () => {
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
        {
          get: () => undefined,
          sync: () => Promise.reject(new Error("the connection closed")),
        },
      );
      await settle();

      expect(observation.states()).toEqual([]);
    });

    it("reports `unknown` for an author whose read the worker refuses", async () => {
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(authoredByLabel("alice")) },
        {
          get: () => undefined,
          sync: () =>
            Promise.reject(
              new CellReadRefusedError({ refusedBy: "display-ceiling" }),
            ),
        },
      );
      await settle();

      expect(observation.states()).toEqual(["unknown"]);
    });

    it("leaves a value whose label read is cancelled unreported, with no unhandled rejection", async () => {
      // A disposal race (logout, runtime swap) rejects the read's IPC with an
      // `AbortError`, which the observation swallows.
      const observation = observe({
        getCfcLabel: () =>
          Promise.reject(new DOMException("aborted", "AbortError")),
      }, "alice");
      await settle();

      expect(observation.states()).toEqual([]);
    });

    it("reports the value's label as it was read", async () => {
      const label = {
        version: 1 as const,
        entries: [{ path: [], label: { integrity: ["x"] } }],
      };
      const observation = observe(
        { getCfcLabel: () => Promise.resolve(label) },
        "alice",
      );
      await settle();

      expect(observation.reports.at(-1)?.cfcLabel).toEqual(label);
    });
  });

  describe("authorClaimLabel()", () => {
    it("returns a claim's display name over its id", () => {
      expect(authorClaimLabel({ id: "alice", name: "Alice Nguyen" })).toBe(
        "Alice Nguyen",
      );
    });

    it("returns a claim's first id when it has no display name", () => {
      expect(authorClaimLabel({ subject: "did:example:alice" })).toBe(
        "did:example:alice",
      );
    });

    it("returns `undefined` for a claim with neither", () => {
      expect(authorClaimLabel(undefined)).toBeUndefined();
    });
  });

  describe("integrity matching", () => {
    it("matches authored-by object atoms by subject", () => {
      expect(integrityAtomMatchesAuthor(
        {
          kind: "authored-by",
          subject: "alice",
        },
        "alice",
        "authored-by",
      )).toBe(true);
      expect(integrityAtomMatchesAuthor(
        {
          kind: "authored-by",
          subject: "alice",
        },
        "bob",
        "authored-by",
      )).toBe(false);
    });

    it("matches object author claims by id without trusting display names", () => {
      expect(integrityAtomMatchesAuthor(
        {
          kind: "authored-by",
          subject: "alice",
        },
        {
          id: "alice",
          name: "Mallory-provided display text",
        },
        "authored-by",
      )).toBe(true);
      expect(integrityAtomMatchesAuthor(
        {
          kind: "authored-by",
          subject: "alice",
        },
        {
          id: "bob",
          name: "Alice Nguyen",
        },
        "authored-by",
      )).toBe(false);
    });

    it("matches no kind the runtime does not guard", () => {
      // A pattern sets `kind` and may write any atom of a kind outside the
      // principal claims, so such an atom proves nothing about its author.
      const view = {
        version: 1 as const,
        entries: [{
          path: [],
          label: { integrity: [{ kind: "x-auth", subject: "alice" }] },
        }],
      };
      expect(integrityAtomMatchesAuthor(
        { kind: "x-auth", subject: "alice" },
        "alice",
        "x-auth",
      )).toBe(false);
      expect(authorshipStateForLabel(view, "alice", "x-auth")).toBe("unknown");
    });

    it("matches a represents-principal claim only when its subject is a DID", () => {
      // Without an owner, a pattern may write a represents-principal subject
      // that is not a DID; no reader takes that for a principal.
      expect(integrityAtomMatchesAuthor(
        { kind: "represents-principal", subject: "alice" },
        "alice",
        "represents-principal",
      )).toBe(false);
    });

    it("counts no string atom as authorship integrity", () => {
      // A spelling no reader matches is not a claim, verified or otherwise.
      const view = {
        version: 1 as const,
        entries: [{
          path: [],
          label: { integrity: ["authored-by:bob"] },
        }],
      };
      expect(authorshipStateForLabel(view, "alice", "authored-by")).toBe(
        "unknown",
      );
    });

    it("matches no string atom and no author field but the subject", () => {
      // The runtime refuses a pattern-authored claim spelled any other way, so
      // these are claims nothing checked.
      expect(integrityAtomMatchesAuthor(
        "authored-by:alice",
        "alice",
        "authored-by",
      )).toBe(false);
      expect(integrityAtomMatchesAuthor(
        { kind: "authored-by", subject: "bob", author: "alice" },
        "alice",
        "authored-by",
      )).toBe(false);
      expect(integrityAtomMatchesAuthor(
        { kind: "authored-by", subject: " alice" },
        "alice",
        "authored-by",
      )).toBe(false);
      expect(integrityAtomMatchesAuthor(
        "alice",
        "alice",
        "authored-by",
      )).toBe(false);
    });

    it("derives state from the integrity label view", () => {
      expect(authorshipStateForLabel(
        {
          version: 1,
          entries: [{
            path: [],
            label: {
              integrity: [{ kind: "authored-by", subject: "alice" }],
            },
          }],
        },
        "alice",
        "authored-by",
      )).toBe("verified");

      expect(authorshipStateForLabel(
        {
          version: 1,
          entries: [{
            path: [],
            label: {
              integrity: [{ kind: "authored-by", subject: "alice" }],
            },
          }],
        },
        "bob",
        "authored-by",
      )).toBe("unverified");
    });

    it("keeps non-authorship integrity unknown instead of unverified", () => {
      expect(authorshipStateForLabel(
        {
          version: 1,
          entries: [{
            path: [],
            label: {
              integrity: [{
                type: "https://commonfabric.org/cfc/atom/LinkReference",
              }],
            },
          }],
        },
        "alice",
        "authored-by",
      )).toBe("unknown");
    });

    it("does not use child path authorship to certify the root value", () => {
      expect(authorshipStateForLabel(
        {
          version: 1,
          entries: [{
            path: ["author", "id"],
            label: {
              integrity: [{ kind: "authored-by", subject: "alice" }],
            },
          }],
        },
        "alice",
        "authored-by",
      )).toBe("unknown");
    });
  });
});
