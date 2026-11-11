import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { type CellHandle, NAME } from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import {
  CFProfileBadge,
  profileDisplayFromValue,
  profileTooltipFromValue,
} from "./index.ts";
import { profileSpaceOf } from "./cf-profile-badge.ts";
import { identitySeal } from "./identity-seal.ts";

const OWNER_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

function representsPrincipalLabel(subject: string) {
  return {
    version: 1,
    entries: [{
      path: ["name"],
      label: { integrity: [{ kind: "represents-principal", subject }] },
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * A resolved root cell `id` in `space`, whose subscription delivers a name
 * with the owner's `represents-principal` label, and whose space cell links
 * `rootId` as its root. Like a runtime's, the space cell resolves its root
 * only once it has been synced, and resolves to itself before that.
 * `spaceCellOpened` holds back the request for the space cell when given,
 * and `spaceCellFailure`, when given, is what that request fails with;
 * `delivered` resolves once the subscription has delivered.
 */
function resolvedInSpace(
  space: string,
  id: string,
  rootId: string,
  spaceCellOpened: Promise<void> = Promise.resolve(),
  spaceCellFailure?: Error,
) {
  let synced = false;
  const delivered = deferred<void>();
  const root = {
    ref: () => ({ path: [] }),
    space: () => space,
    id: () => rootId,
  };
  const unsynced = {
    ref: () => ({ path: [] }),
    space: () => space,
    id: () => "of:space-cell",
  };
  const spaceCell = {
    sync: () => {
      synced = true;
      return Promise.resolve();
    },
    key: () => ({
      resolveAsCell: () => Promise.resolve(synced ? root : unsynced),
    }),
  };
  return {
    ref: () => ({ path: [] }),
    space: () => space,
    id: () => id,
    runtime: () => ({
      signal: new AbortController().signal,
      getCell: async (requested: string, cause: string) => {
        await spaceCellOpened;
        if (spaceCellFailure !== undefined) throw spaceCellFailure;
        if (requested !== space || cause !== space) {
          throw new Error("not the space cell");
        }
        return spaceCell;
      },
    }),
    asSchema: () => ({
      key: () => faceField(undefined),
      subscribe: (cb: (val: unknown, label?: unknown) => void) => {
        cb({ name: "Ada" }, representsPrincipalLabel(OWNER_DID));
        delivered.resolve();
        return () => {};
      },
    }),
    delivered: delivered.promise,
  };
}

/** A badge bound to `resolved`, as a binding to a profile link resolves. */
function badgeOver(resolved: unknown): CFProfileBadge {
  const badge = new CFProfileBadge();
  markConnected(badge, true);
  badge.profile = {
    resolveAsCell: () => Promise.resolve(resolved),
  } as unknown as CFProfileBadge["profile"];
  return badge;
}

/**
 * A runtime stub in which every space's root is a document other than the
 * cell under test, so `profileSpaceOf()` returns `undefined` for that cell.
 */
function runtimeWithOtherRoot() {
  return {
    signal: new AbortController().signal,
    getCell: (space: string) =>
      Promise.resolve({
        sync: () => Promise.resolve(),
        key: () => ({
          resolveAsCell: () =>
            Promise.resolve({
              ref: () => ({ path: [] }),
              space: () => space,
              id: () => "of:other-root",
            }),
        }),
      }),
  };
}

/**
 * A runtime in which each space of `roots` links the document named there as
 * its root, counting the times a space cell is opened. Opening one fails with
 * `failure` while `failing` is set.
 */
function countingRuntime(roots: Record<string, string>, failure?: Error) {
  let opened = 0;
  let failing = failure !== undefined;
  return {
    signal: new AbortController().signal,
    getCell: (space: string) => {
      opened++;
      if (failing) return Promise.reject(failure);
      return Promise.resolve({
        sync: () => Promise.resolve(),
        key: () => ({
          resolveAsCell: () =>
            Promise.resolve({
              ref: () => ({ path: [] }),
              space: () => space,
              id: () => roots[space],
            }),
        }),
      });
    },

    /** How many times a space cell has been opened. */
    opened: () => opened,

    /** Lets the space cells open from here on. */
    recover: () => {
      failing = false;
    },
  };
}

/** The root cell `id` of `space`, read through `runtime`. */
function rootCell(runtime: unknown, space: string, id: string): CellHandle {
  return {
    ref: () => ({ path: [] }),
    space: () => space,
    id: () => id,
    runtime: () => runtime,
  } as unknown as CellHandle;
}

function markConnected(element: CFProfileBadge, isConnected = true): void {
  Object.defineProperty(element, "isConnected", {
    configurable: true,
    value: isConnected,
  });
}

/**
 * A resolved-cell stub for the navigation tests: a root cell (empty `path`) is a
 * navigable profile piece; a sub-path cell is not. The minimal `asSchema` /
 * `getCfcLabel` surface keeps `_resolve` + `_refreshVerification` happy.
 */
function navResolvedCell(
  opts: { path: PropertyKey[]; space?: string; id?: string },
) {
  return {
    ref: () => ({ path: opts.path }),
    space: () => opts.space ?? "did:key:zSpace",
    id: () => opts.id ?? "fid1:piece",
    runtime: runtimeWithOtherRoot,
    asSchema: () => ({
      key: () => faceField(undefined),
      subscribe: (cb: (val: unknown) => void) => {
        cb({ name: "Ada" });
        return () => {};
      },
    }),
    getCfcLabel: () => Promise.resolve(undefined),
  };
}

/**
 * A handle on the cell holding one field of a profile's face: it resolves to
 * itself, and its subscription delivers `value` with `label`. `id` tells two
 * fields apart, and `delivered` resolves once the subscription has delivered.
 */
function faceField(value: unknown, label?: unknown, id = "of:face") {
  const delivered = deferred<void>();
  const cell = {
    ref: () => ({ space: "did:key:zSpace", id, path: [] }),
    space: () => "did:key:zSpace",
    id: () => id,
    runtime: runtimeWithOtherRoot,
    resolveAsCellWithWriteTarget: () =>
      Promise.resolve({ cell, writeTarget: cell }),
    subscribe: (
      cb: (
        val: unknown,
        label?: unknown,
        delivery?: { cfcLabelCurrent: boolean },
      ) => void,
    ) => {
      cb(value, label, { cfcLabelCurrent: true });
      delivered.resolve();
      return () => {};
    },
    delivered: delivered.promise,
  };
  return cell;
}

/** The label a write of a face field by `subject` stores on its cell. */
function writtenBy(subject: string) {
  return {
    version: 1,
    entries: [{
      path: [],
      label: { integrity: [{ kind: "represents-principal", subject }] },
    }],
  };
}

// deno-lint-ignore no-explicit-any
function fakeClick(): any {
  return { stopPropagation() {}, metaKey: false, ctrlKey: false };
}

/**
 * The values bound by the nested template whose markup contains `marker`.
 *
 * Asserting on the serialized whole cannot tell an avatar's `name` from the
 * text beside it: every variant puts the name in an outer span or an
 * aria-label, so a fallback that reached ONLY that path looks identical to
 * one that reached the avatar and the tooltip as well.
 */
function bindingsOfTemplateWith(
  node: unknown,
  marker: string,
): unknown[] | undefined {
  if (!isObjectOrArray(node)) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = bindingsOfTemplateWith(child, marker);
      if (found) return found;
    }
    return undefined;
  }
  const template = node as { strings?: unknown; values?: unknown[] };
  if (
    Array.isArray(template.strings) &&
    template.strings.join("").includes(marker)
  ) {
    return template.values ?? [];
  }
  for (const value of template.values ?? []) {
    const found = bindingsOfTemplateWith(value, marker);
    if (found) return found;
  }
  return undefined;
}

describe("CFProfileBadge", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-profile-badge")).toBe(CFProfileBadge);
  });

  it("defaults to a medium avatar in the presented state", () => {
    const el = new CFProfileBadge();
    expect(el.size).toBe("md");
  });

  describe("fallback name", () => {
    it("is undefined by default, so an unresolved badge still says so", () => {
      const el = new CFProfileBadge();
      expect(el.fallbackName).toBeUndefined();
    });

    it("presents a stored name where no profile resolves", () => {
      // A roster row written before the space had profiles knows the name it
      // stored; showing it beats telling the reader the person is unknown.
      const el = new CFProfileBadge() as any;
      el.fallbackName = "Alex";
      expect(JSON.stringify(el.render())).toContain("Alex");
    });

    it("never lets the fallback stand in for a resolved profile", () => {
      // A fallback that could shadow a real identity would be a way to label
      // someone as somebody else.
      const el = new CFProfileBadge() as any;
      el._name = "Ada";
      el._resolved = true;
      el.fallbackName = "Alex";
      const html = JSON.stringify(el.render());
      expect(html).toContain("Ada");
      expect(html).not.toContain("Alex");
    });

    it("keeps the fallback when resolution produced no value at all", () => {
      // The no-cell and failed-resolve paths both apply `undefined`. Treating
      // those as "resolved" would suppress the fallback in exactly the case it
      // exists for — a roster row that never had a profile to resolve.
      const el = new CFProfileBadge() as any;
      el.fallbackName = "Alex";
      el._applyValue(undefined);
      expect(el._resolved).toBe(false);
      expect(JSON.stringify(el.render())).toContain("Alex");
    });

    it("refuses the fallback for a resolved profile that carries no name", () => {
      // The sharp case: verification comes from the resolved cell's label, not
      // from the name, so a nameless VERIFIED profile would otherwise render a
      // caller's string beside a seal it did not earn.
      const el = new CFProfileBadge() as any;
      el._resolved = true;
      el._state = "verified";
      el._seal = identitySeal(OWNER_DID);
      el.fallbackName = "Alice";
      const html = JSON.stringify(el.render());
      expect(html).not.toContain("Alice");
      expect(html).toContain("Unknown profile");
    });

    it("does not carry the seal while presenting a fallback", () => {
      // Verification can be derived from a resolved cell's LABEL while no
      // value arrived, so this is the state the component can really be in —
      // not a contrived one.
      const el = new CFProfileBadge() as any;
      el._state = "verified";
      el._seal = identitySeal(OWNER_DID);
      el.fallbackName = "Alex";
      const html = JSON.stringify(el.render());
      expect(html).toContain("Alex");
      expect(html).not.toContain(identitySeal(OWNER_DID).accent);
    });

    it("reports no verified state or liveness while presenting a fallback", () => {
      // The seal is one claim wearing three faces — the seal nodes,
      // `data-state` (which the verified CSS keys on), and the cursor-sheen
      // liveness. Guarding only the nodes leaves the other two asserting it.
      const el = new CFProfileBadge() as any;
      el._state = "verified";
      el._seal = identitySeal(OWNER_DID);
      el.fallbackName = "Alex";
      expect(el._verified).toBe(false);
      expect(JSON.stringify(el.render())).not.toContain('"verified"');
    });

    it("shows a profile the worker refuses as withheld, with no seal and no fallback", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el);
      el._applyValue({ name: "Ada" });
      el._state = "verified";
      el._seal = identitySeal(OWNER_DID);
      el.fallbackName = "Alex";

      el._applyRefusal(el._resolveGeneration);

      const html = JSON.stringify(el.render());
      expect(html).toContain("Content hidden by policy");
      expect(html).not.toContain("Ada");
      expect(html).not.toContain("Alex");
      expect(el._verified).toBe(false);
    });

    it("reports verified once a value and a label have both arrived", () => {
      // The boundary must not swallow the real case it is protecting.
      const el = new CFProfileBadge() as any;
      el._applyValue({ name: "Ada" });
      el._state = "verified";
      el._seal = identitySeal(OWNER_DID);
      el.accessForTestingOnly.profileKnown = true;
      expect(el._verified).toBe(true);
      expect(JSON.stringify(el.render())).toContain("verified");
    });

    it("presents the fallback through every variant's name and avatar", () => {
      // Asserted on the AVATAR and TOOLTIP bindings, not on the string
      // appearing anywhere: the outer name span and the aria-label carry it in
      // every variant, so a check for "Alex" somewhere passes while the avatar
      // still renders "?" and the tooltip still says "Profile" — which is
      // exactly the state this is here to catch.
      for (const variant of ["full", "circle", "hero"] as const) {
        const el = new CFProfileBadge() as any;
        el.variant = variant;
        el.fallbackName = "Alex";
        const avatar = bindingsOfTemplateWith(el.render(), "<cf-avatar");
        expect(avatar, `${variant} renders no avatar`).toBeDefined();
        expect(avatar, `${variant} avatar took no name`).toContain("Alex");
      }

      // `circle` hides the name, so its tooltip is where the fallback has to
      // land; unfixed it read "Profile".
      const circle = new CFProfileBadge() as any;
      circle.variant = "circle";
      circle.fallbackName = "Alex";
      const tooltip = bindingsOfTemplateWith(circle.render(), "tooltip-name");
      expect(tooltip).toBeDefined();
      expect(tooltip).toContain("Alex");
      expect(tooltip).not.toContain("Profile");
    });
  });

  describe("variants (CT-1761)", () => {
    it("defaults to the full variant", () => {
      const el = new CFProfileBadge();
      expect(el.variant).toBe("full");
    });

    it("renders without throwing for every variant in presented + verified states", () => {
      // The render branches (avatar vs seal-dot, name on/off, shield on/off,
      // circle aria-label, inline accent styles) must all be reachable without a
      // DOM. The real visual check is the browser pass; this guards the wiring.
      for (const variant of ["full", "chip", "circle", "hero"] as const) {
        const el = new CFProfileBadge() as any;
        el.variant = variant;
        el._applyValue({ name: "Ada" });
        expect(el.render()).toBeTruthy(); // presented

        el._state = "verified";
        el._seal = identitySeal(OWNER_DID);
        el.accessForTestingOnly.profileKnown = true;
        expect(el._verified).toBe(true);
        expect(JSON.stringify(el.render())).toContain('"verified"');
      }
    });
  });

  describe("async resolve lifecycle", () => {
    it("does not subscribe when the element disconnects during resolve", async () => {
      const slowResolution = deferred<any>();
      let subscribeCount = 0;
      const resolvedCell = {
        ref: () => ({ path: [] }),
        asSchema: () => ({
          key: () => faceField(undefined),
          subscribe: () => {
            subscribeCount++;
            return () => {};
          },
        }),
      };
      const cell = {
        resolveAsCell: () => slowResolution.promise,
      } as any;

      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = cell;

      // Kick off the async resolve, then disconnect while it is still awaiting
      // `resolveAsCell()`.
      const resolving = el._resolve();
      el.disconnectedCallback();
      markConnected(el, false);

      // The resolution lands after disconnect — the generation guard (bumped by
      // disconnectedCallback) plus the isConnected check must prevent any
      // subscription on the detached instance.
      slowResolution.resolve(resolvedCell);
      await resolving;

      expect(subscribeCount).toBe(0);
      expect(el._unsubscribe).toBeUndefined();
    });

    it("subscribes when the resolve completes while still connected", async () => {
      const slowResolution = deferred<any>();
      let subscribeCount = 0;
      let unsubscribeCount = 0;
      const resolvedCell = {
        ref: () => ({ path: [] }),
        space: () => "did:key:zSpace",
        id: () => "fid1:piece",
        runtime: runtimeWithOtherRoot,
        asSchema: () => ({
          key: () => faceField(undefined),
          subscribe: (cb: (val: unknown) => void) => {
            subscribeCount++;
            cb({ name: "Ada", avatar: undefined });
            return () => {
              unsubscribeCount++;
            };
          },
        }),
      };
      const cell = {
        resolveAsCell: () => slowResolution.promise,
      } as any;

      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = cell;

      const resolving = el._resolve();
      slowResolution.resolve(resolvedCell);
      await resolving;

      expect(subscribeCount).toBe(1);
      expect(el._name).toBe("Ada");
      expect(typeof el._unsubscribe).toBe("function");

      // disconnectedCallback should tear the live subscription down.
      el.disconnectedCallback();
      expect(unsubscribeCount).toBe(1);
      expect(el._unsubscribe).toBeUndefined();
    });

    describe("an update that reports the profile changed", () => {
      /** A profile binding that counts the times it is resolved. */
      const countingProfile = () => {
        let resolutions = 0;
        return {
          cell: {
            resolveAsCell: () => {
              resolutions++;
              return Promise.resolve(navResolvedCell({ path: [] }));
            },
          } as unknown as CFProfileBadge["profile"],
          resolutions: () => resolutions,
        };
      };
      const profileChanged = new Map([["profile", undefined]]);

      it("resolves the profile once when it was bound before the element connected", async () => {
        const profile = countingProfile();
        const badge = new CFProfileBadge();
        markConnected(badge, true);
        badge.profile = profile.cell;

        // Connecting resolves the profile, and the first update after it
        // reports the profile changed.
        const resolving = badge.accessForTestingOnly.resolve();
        badge.accessForTestingOnly.willUpdate(profileChanged);
        await resolving;

        expect(profile.resolutions()).toBe(1);
      });

      it("resolves a profile bound in place of the one resolved", async () => {
        const first = countingProfile();
        const second = countingProfile();
        const badge = new CFProfileBadge();
        markConnected(badge, true);
        badge.profile = first.cell;
        await badge.accessForTestingOnly.resolve();

        badge.profile = second.cell;
        badge.accessForTestingOnly.willUpdate(profileChanged);

        expect(second.resolutions()).toBe(1);
      });

      it("resolves the same profile again after a disconnection", async () => {
        const profile = countingProfile();
        const badge = new CFProfileBadge();
        markConnected(badge, true);
        badge.profile = profile.cell;
        await badge.accessForTestingOnly.resolve();

        badge.disconnectedCallback();
        badge.accessForTestingOnly.willUpdate(profileChanged);

        expect(profile.resolutions()).toBe(2);
      });
    });
  });

  describe("verification seal", () => {
    it("enters the verified state and derives the seal from the owner DID", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      el._deriveVerification(
        representsPrincipalLabel(OWNER_DID),
        el._resolveGeneration,
        false,
      );

      expect(el._state).toBe("verified");
      // The seal is the pure DID-derived fingerprint, identical everywhere.
      expect(el._seal?.did).toBe(OWNER_DID);
      expect(el._seal?.hue).toBe(identitySeal(OWNER_DID).hue);
    });

    it("re-derives verification when the label arrives over the subscription (cold self-heals)", async () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      // The subscription delivers (value, cfcLabel). Cold first: value but no
      // label; then the label appears once the profile doc loads — over the
      // SAME subscription, no separate getCfcLabel read.
      let deliver: ((val: unknown, label?: unknown) => void) | undefined;
      const resolved = {
        ref: () => ({ path: [] }),
        space: () => "did:key:zSpace",
        id: () => "fid1:piece",
        runtime: runtimeWithOtherRoot,
        asSchema: () => ({
          key: () => faceField(undefined),
          subscribe: (cb: (val: unknown, label?: unknown) => void) => {
            deliver = cb;
            return () => {};
          },
        }),
      };
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };

      await el._resolve();

      deliver?.({ name: "Ada" }, undefined);
      expect(el._state).toBe("presented");
      expect(el._seal).toBeUndefined();

      // The label-only change (doc loaded) re-fires the subscription.
      deliver?.({ name: "Ada" }, representsPrincipalLabel(OWNER_DID));
      expect(el._state).toBe("verified");
      expect(el._seal?.did).toBe(OWNER_DID);
    });

    it("enters the verified state for the owner a written name names, and stays presented for the same label with no name written", async () => {
      // A default field the runtime that set the profile up stamped with its
      // own principal, beside the owner's.
      const stamped = {
        version: 1,
        entries: [
          {
            path: ["name"],
            label: {
              integrity: [{ kind: "represents-principal", subject: OWNER_DID }],
            },
          },
          {
            path: ["avatar"],
            label: {
              integrity: [
                { kind: "represents-principal", subject: OWNER_DID },
                { kind: "represents-principal", subject: "did:key:zRunner" },
              ],
            },
          },
        ],
      };
      let deliver: ((val: unknown, label?: unknown) => void) | undefined;
      const badge = badgeOver({
        ref: () => ({ path: [] }),
        space: () => "did:key:zSpace",
        id: () => "fid1:piece",
        runtime: runtimeWithOtherRoot,
        asSchema: () => ({
          key: () => faceField(undefined),
          subscribe: (cb: (val: unknown, label?: unknown) => void) => {
            deliver = cb;
            return () => {};
          },
        }),
      });
      await badge.accessForTestingOnly.resolve();

      deliver?.({ name: "" }, stamped);
      expect(badge.accessForTestingOnly.state).toBe("presented");

      deliver?.({ name: "Ada" }, stamped);
      expect(badge.accessForTestingOnly.state).toBe("verified");
      expect(badge.accessForTestingOnly.seal?.did).toBe(OWNER_DID);
    });

    it("seeds the seal with the space when the cell is its space's root profile", async () => {
      const space = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";
      const badge = badgeOver(
        resolvedInSpace(space, "of:profile", "of:profile"),
      );

      await badge.accessForTestingOnly.resolve();

      expect(badge.accessForTestingOnly.verified).toBe(true);
      expect(badge.accessForTestingOnly.seal?.ringGradient).toBe(
        identitySeal(OWNER_DID, space).ringGradient,
      );
      expect(badge.accessForTestingOnly.seal?.ringGradient).not.toBe(
        identitySeal(OWNER_DID).ringGradient,
      );
    });

    it("keeps the seal the principal's alone for a document that is not its space's root", async () => {
      const space = "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG";
      const badge = badgeOver(
        resolvedInSpace(space, "of:roster-entry", "of:room"),
      );

      await badge.accessForTestingOnly.resolve();

      expect(badge.accessForTestingOnly.verified).toBe(true);
      expect(badge.accessForTestingOnly.seal?.ringGradient).toBe(
        identitySeal(OWNER_DID).ringGradient,
      );
    });

    it("presents no seal until it knows whether the cell is a profile", async () => {
      const space = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";
      const opened = deferred<void>();
      const resolved = resolvedInSpace(
        space,
        "of:profile",
        "of:profile",
        opened.promise,
      );
      const badge = badgeOver(resolved);

      const resolving = badge.accessForTestingOnly.resolve();
      // The label has arrived; the space cell has not been opened.
      await resolved.delivered;
      expect(badge.accessForTestingOnly.state).toBe("verified");
      expect(badge.accessForTestingOnly.verified).toBe(false);

      opened.resolve();
      await resolving;
      expect(badge.accessForTestingOnly.verified).toBe(true);
      expect(badge.accessForTestingOnly.seal?.ringGradient).toBe(
        identitySeal(OWNER_DID, space).ringGradient,
      );
    });

    it("draws no seal, logs, and keeps the name when whether the cell is a profile cannot be read", async () => {
      const space = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";
      const failure = new Error("the space's root cannot be read");
      const badge = badgeOver(
        resolvedInSpace(
          space,
          "of:profile",
          "of:profile",
          Promise.resolve(),
          failure,
        ),
      );
      const logged: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => logged.push(args);
      try {
        await badge.accessForTestingOnly.resolve();
      } finally {
        console.error = original;
      }

      expect(badge.accessForTestingOnly.state).toBe("verified");
      expect(badge.accessForTestingOnly.profileKnown).toBe(false);
      expect(badge.accessForTestingOnly.verified).toBe(false);
      expect(JSON.stringify(badge.render())).toContain("Ada");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(failure);
    });

    it("stays presented (no seal) when the label has no represents-principal atom", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      el._deriveVerification(
        {
          version: 1,
          entries: [{ path: [], label: { integrity: ["profile-link"] } }],
        },
        el._resolveGeneration,
        false,
      );

      expect(el._state).toBe("presented");
      expect(el._seal).toBeUndefined();
    });

    it("clears a prior seal up-front on re-bind, before the new attestation resolves", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      // Simulate an already-verified badge for some other identity.
      el._state = "verified";
      el._seal = identitySeal(OWNER_DID);

      // Re-bind to a different, never-resolving profile. `_resolve` resets the
      // verification synchronously before its first await, so the stale seal
      // must be gone immediately — it never lingers during the async gap.
      el.profile = { resolveAsCell: () => new Promise(() => {}) };
      void el._resolve();

      expect(el._state).toBe("presented");
      expect(el._seal).toBeUndefined();
    });

    it("ignores a label delivered after a re-bind (stale generation)", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      const staleGeneration = el._resolveGeneration;
      // A re-bind / disconnect bumps the generation.
      el._resolveGeneration++;

      // A subscription callback from the prior binding fires late with a valid
      // attestation — it must NOT flip the badge to verified.
      el._deriveVerification(
        representsPrincipalLabel(OWNER_DID),
        staleGeneration,
        false,
      );

      expect(el._state).toBe("presented");
      expect(el._seal).toBeUndefined();
    });
  });

  describe("navigation (CT-1750)", () => {
    it("navigates to the profile page when bound to a root profile cell", async () => {
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceX",
        id: "fid1:profileX",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      expect(el._navigable).toBe(true);

      let captured: unknown;
      const onNav = (e: Event) => {
        captured = (e as CustomEvent).detail;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        el._handleClick(fakeClick());
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
      }

      expect(captured).toEqual({
        spaceDid: "did:key:zSpaceX",
        pieceId: "fid1:profileX",
      });
    });

    it("does not navigate when bound to a non-root (derived/sub-path) cell", async () => {
      const resolved = navResolvedCell({ path: ["name"] });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      expect(el._navigable).toBe(false);

      let navigated = false;
      const onNav = () => {
        navigated = true;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        el._handleClick(fakeClick());
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
      }

      expect(navigated).toBe(false);
    });

    it("opens a new tab (not in-place navigate) on cmd/ctrl-click", async () => {
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceX",
        id: "fid1:profileX",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      // `_navigateToProfile` composes the new-tab URL from `location.href`;
      // Deno has no `location` unless --location is set, so stub it.
      const hadLocation = "location" in globalThis &&
        globalThis.location !== undefined;
      // deno-lint-ignore no-explicit-any
      const origLocation = (globalThis as any).location;
      // deno-lint-ignore no-explicit-any
      const origOpen = (globalThis as any).open;
      let openedUrl: string | undefined;
      let openedTarget: string | undefined;
      let navigated = false;
      const onNav = () => {
        navigated = true;
      };
      Object.defineProperty(globalThis, "location", {
        value: { href: "http://localhost:8000/home" },
        configurable: true,
        writable: true,
      });
      // deno-lint-ignore no-explicit-any
      (globalThis as any).open = (url: string, target: string) => {
        openedUrl = url;
        openedTarget = target;
        return null;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        el._handleClick({
          stopPropagation() {},
          metaKey: true,
          ctrlKey: false,
          // deno-lint-ignore no-explicit-any
        } as any);
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
        // deno-lint-ignore no-explicit-any
        (globalThis as any).open = origOpen;
        if (hadLocation) {
          Object.defineProperty(globalThis, "location", {
            value: origLocation,
            configurable: true,
            writable: true,
          });
        } else {
          // deno-lint-ignore no-explicit-any
          delete (globalThis as any).location;
        }
      }

      expect(openedTarget).toBe("_blank");
      expect(openedUrl).toContain("fid1:profileX");
      // New-tab must NOT also fire the in-place navigation.
      expect(navigated).toBe(false);
    });

    it("cmd/ctrl-click dispatches cancellable cf-open-external (CT-1830)", async () => {
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceX",
        id: "fid1:profileX",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      const hadLocation = "location" in globalThis &&
        globalThis.location !== undefined;
      // deno-lint-ignore no-explicit-any
      const origLocation = (globalThis as any).location;
      // deno-lint-ignore no-explicit-any
      const origOpen = (globalThis as any).open;
      let captured: unknown;
      let cancelable = false;
      const onOpen = (e: Event) => {
        captured = (e as CustomEvent).detail;
        cancelable = e.cancelable;
      };
      Object.defineProperty(globalThis, "location", {
        value: { href: "http://localhost:8000/home" },
        configurable: true,
        writable: true,
      });
      // deno-lint-ignore no-explicit-any
      (globalThis as any).open = () => null;
      globalThis.addEventListener("cf-open-external", onOpen);
      try {
        el._handleClick({
          stopPropagation() {},
          metaKey: true,
          ctrlKey: false,
          // deno-lint-ignore no-explicit-any
        } as any);
      } finally {
        globalThis.removeEventListener("cf-open-external", onOpen);
        // deno-lint-ignore no-explicit-any
        (globalThis as any).open = origOpen;
        if (hadLocation) {
          Object.defineProperty(globalThis, "location", {
            value: origLocation,
            configurable: true,
            writable: true,
          });
        } else {
          // deno-lint-ignore no-explicit-any
          delete (globalThis as any).location;
        }
      }

      expect(captured).toEqual({
        spaceDid: "did:key:zSpaceX",
        pieceId: "fid1:profileX",
      });
      expect(cancelable).toBe(true);
    });

    it("preventDefault() on cf-open-external suppresses globalThis.open (CT-1830)", async () => {
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceX",
        id: "fid1:profileX",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      const hadLocation = "location" in globalThis &&
        globalThis.location !== undefined;
      // deno-lint-ignore no-explicit-any
      const origLocation = (globalThis as any).location;
      // deno-lint-ignore no-explicit-any
      const origOpen = (globalThis as any).open;
      let opened = false;
      const onOpen = (e: Event) => e.preventDefault();
      Object.defineProperty(globalThis, "location", {
        value: { href: "http://localhost:8000/home" },
        configurable: true,
        writable: true,
      });
      // deno-lint-ignore no-explicit-any
      (globalThis as any).open = () => {
        opened = true;
        return null;
      };
      globalThis.addEventListener("cf-open-external", onOpen);
      try {
        el._handleClick({
          stopPropagation() {},
          metaKey: true,
          ctrlKey: false,
          // deno-lint-ignore no-explicit-any
        } as any);
      } finally {
        globalThis.removeEventListener("cf-open-external", onOpen);
        // deno-lint-ignore no-explicit-any
        (globalThis as any).open = origOpen;
        if (hadLocation) {
          Object.defineProperty(globalThis, "location", {
            value: origLocation,
            configurable: true,
            writable: true,
          });
        } else {
          // deno-lint-ignore no-explicit-any
          delete (globalThis as any).location;
        }
      }

      expect(opened).toBe(false);
    });

    it("stays non-navigable when noNavigate is set, even on a root cell", async () => {
      // The profile-home self-badge is bound to a `computed()` projection that
      // happens to resolve as a root cell (path []) but is NOT a real piece, so
      // navigating would route to a non-piece cell id. `noNavigate` suppresses
      // it (a root cell would otherwise be navigable — see the first test).
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceN",
        id: "fid1:profileN",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.noNavigate = true;
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      expect(el._navigable).toBe(false);

      let navigated = false;
      const onNav = () => {
        navigated = true;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        // Even a direct call is guarded (belt-and-braces with `_navigable`).
        el._navigateToProfile(false);
        el._handleClick(fakeClick());
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
      }

      expect(navigated).toBe(false);
    });

    it("navigates on Enter and Space keydown", async () => {
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceK",
        id: "fid1:profileK",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      for (const key of ["Enter", " "]) {
        let captured: unknown;
        let prevented = false;
        const onNav = (e: Event) => {
          captured = (e as CustomEvent).detail;
        };
        globalThis.addEventListener("cf-navigate", onNav);
        try {
          el._handleKeydown({
            key,
            metaKey: false,
            ctrlKey: false,
            preventDefault() {
              prevented = true;
            },
            // deno-lint-ignore no-explicit-any
          } as any);
        } finally {
          globalThis.removeEventListener("cf-navigate", onNav);
        }
        expect(captured).toEqual({
          spaceDid: "did:key:zSpaceK",
          pieceId: "fid1:profileK",
        });
        expect(prevented).toBe(true);
      }
    });

    it("ignores non-activation keydowns", async () => {
      const resolved = navResolvedCell({ path: [] });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      let navigated = false;
      const onNav = () => {
        navigated = true;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        el._handleKeydown({
          key: "a",
          metaKey: false,
          ctrlKey: false,
          preventDefault() {},
          // deno-lint-ignore no-explicit-any
        } as any);
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
      }

      expect(navigated).toBe(false);
    });
  });

  describe("profileSpaceOf()", () => {
    const SPACE = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";
    const OTHER_SPACE =
      "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG";

    it("reads a space's root once for calls that overlap", async () => {
      const runtime = countingRuntime({ [SPACE]: "of:profile" });

      const spaces = await Promise.all([
        profileSpaceOf(rootCell(runtime, SPACE, "of:profile")),
        profileSpaceOf(rootCell(runtime, SPACE, "of:roster-entry")),
        profileSpaceOf(rootCell(runtime, SPACE, "of:profile")),
      ]);

      expect(spaces).toEqual([SPACE, undefined, SPACE]);
      expect(runtime.opened()).toBe(1);
    });

    it("reads a space's root again for a call made after a read has finished", async () => {
      const runtime = countingRuntime({ [SPACE]: "of:profile" });

      await profileSpaceOf(rootCell(runtime, SPACE, "of:profile"));
      const space = await profileSpaceOf(
        rootCell(runtime, SPACE, "of:profile"),
      );

      expect(space).toBe(SPACE);
      expect(runtime.opened()).toBe(2);
    });

    it("reads each space's root for overlapping calls about different spaces", async () => {
      const runtime = countingRuntime({
        [SPACE]: "of:profile",
        [OTHER_SPACE]: "of:room",
      });

      const spaces = await Promise.all([
        profileSpaceOf(rootCell(runtime, SPACE, "of:profile")),
        profileSpaceOf(rootCell(runtime, OTHER_SPACE, "of:profile")),
      ]);

      expect(spaces).toEqual([SPACE, undefined]);
      expect(runtime.opened()).toBe(2);
    });

    it("reads a space's root through each runtime that asks", async () => {
      const first = countingRuntime({ [SPACE]: "of:profile" });
      const second = countingRuntime({ [SPACE]: "of:room" });

      const spaces = await Promise.all([
        profileSpaceOf(rootCell(first, SPACE, "of:profile")),
        profileSpaceOf(rootCell(second, SPACE, "of:profile")),
      ]);

      expect(spaces).toEqual([SPACE, undefined]);
      expect(first.opened()).toBe(1);
      expect(second.opened()).toBe(1);
    });

    it("rejects every overlapping call when the root cannot be read, and reads again for a later call", async () => {
      const failure = new Error("the space's root cannot be read");
      const runtime = countingRuntime({ [SPACE]: "of:profile" }, failure);

      const outcomes = await Promise.allSettled([
        profileSpaceOf(rootCell(runtime, SPACE, "of:profile")),
        profileSpaceOf(rootCell(runtime, SPACE, "of:profile")),
      ]);
      runtime.recover();
      const space = await profileSpaceOf(
        rootCell(runtime, SPACE, "of:profile"),
      );

      expect(outcomes).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      expect(space).toBe(SPACE);
      expect(runtime.opened()).toBe(2);
    });

    it("returns `undefined` for a cell below a document's root, reading nothing", async () => {
      const runtime = countingRuntime({ [SPACE]: "of:profile" });
      const field = {
        ...rootCell(runtime, SPACE, "of:profile"),
        ref: () => ({ path: ["name"] }),
      } as unknown as CellHandle;

      expect(await profileSpaceOf(field)).toBeUndefined();
      expect(runtime.opened()).toBe(0);
    });
  });

  describe("face", () => {
    const VISITOR_DID =
      "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
    const picture = new FabricBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    /**
     * The face a badge draws for a profile whose label names `owner`, and
     * whose picture and avatar cells hold what `fields` says, each as its
     * value and the label of its cell. The profile's label is the one the
     * worker read with its value only when `current`.
     */
    async function faceOf(
      owner: string | undefined,
      fields: Record<"picture" | "avatar", [unknown, unknown]>,
      current = true,
    ) {
      const cells = {
        picture: faceField(...fields.picture, "of:picture"),
        avatar: faceField(...fields.avatar, "of:avatar"),
      };
      const badge = badgeOver({
        ref: () => ({ path: [] }),
        space: () => "did:key:zSpace",
        id: () => "fid1:piece",
        runtime: runtimeWithOtherRoot,
        asSchema: () => ({
          key: (field: "picture" | "avatar") => cells[field],
          subscribe: (
            cb: (
              val: unknown,
              label?: unknown,
              delivery?: { cfcLabelCurrent: boolean },
            ) => void,
          ) => {
            cb(
              { name: "Ada" },
              owner === undefined ? undefined : representsPrincipalLabel(owner),
              { cfcLabelCurrent: current },
            );
            return () => {};
          },
        }),
      });
      await badge.accessForTestingOnly.resolve();
      await Promise.all([cells.picture.delivered, cells.avatar.delivered]);
      // The fakes answer through settled promises, so one zero-delay turn
      // finishes every resolve the face observation started.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return badge.accessForTestingOnly.face;
    }

    it("draws the picture its owner set", async () => {
      expect(
        await faceOf(OWNER_DID, {
          picture: [picture, writtenBy(OWNER_DID)],
          avatar: ["🦊", writtenBy(OWNER_DID)],
        }),
      ).toEqual({ picture, avatar: undefined });
    });

    it("draws the owner's avatar in place of a picture someone else set", async () => {
      expect(
        await faceOf(OWNER_DID, {
          picture: [picture, writtenBy(VISITOR_DID)],
          avatar: [" 🦊 ", writtenBy(OWNER_DID)],
        }),
      ).toEqual({ picture: undefined, avatar: "🦊" });
    });

    it("draws neither a picture stored without a label nor an avatar someone else set", async () => {
      expect(
        await faceOf(OWNER_DID, {
          picture: [picture, undefined],
          avatar: ["🦊", writtenBy(VISITOR_DID)],
        }),
      ).toEqual({ picture: undefined, avatar: undefined });
    });

    it("draws no face while the profile's label is not the one the worker read with its value", async () => {
      expect(
        await faceOf(OWNER_DID, {
          picture: [picture, writtenBy(OWNER_DID)],
          avatar: ["🦊", writtenBy(OWNER_DID)],
        }, false),
      ).toEqual({ picture: undefined, avatar: undefined });
    });

    it("draws no face for a profile whose label names no one", async () => {
      expect(
        await faceOf(undefined, {
          picture: [picture, writtenBy(OWNER_DID)],
          avatar: ["🦊", writtenBy(OWNER_DID)],
        }),
      ).toEqual({ picture: undefined, avatar: undefined });
    });
  });

  describe("profileDisplayFromValue", () => {
    it("prefers the profile's name field over the cell [NAME]", () => {
      // On main, profile-home's [NAME] is the static placeholder "Profile"
      // (profile-home.tsx:303); the editable `name` field is the real name.
      const val = {
        [NAME]: "Profile",
        name: "Ben",
        avatar: "https://example.com/ben.png",
      };
      expect(profileDisplayFromValue(val)).toEqual({ name: "Ben" });
    });

    it("falls back to the cell [NAME] when the name field is blank", () => {
      const val = { [NAME]: "Ada Lovelace", name: "  ", avatar: "🦊" };
      expect(profileDisplayFromValue(val)).toEqual({ name: "Ada Lovelace" });
    });

    it("returns undefined fields for empty / non-object input", () => {
      const none = { name: undefined };
      expect(profileDisplayFromValue(undefined)).toEqual(none);
      expect(profileDisplayFromValue("nope")).toEqual(none);
      expect(profileDisplayFromValue({})).toEqual(none);
    });
  });

  describe("profileTooltipFromValue (CT-1648)", () => {
    it("extracts a trimmed bio and the pinned-element count", () => {
      const val = {
        name: "Ada",
        bio: "  Mathematician & first programmer.  ",
        elements: [{ title: "Counter" }, { title: "Notes" }],
      };
      expect(profileTooltipFromValue(val)).toEqual({
        bio: "Mathematician & first programmer.",
        pinnedCount: 2,
      });
    });

    it("treats a blank bio as none and a missing elements list as zero", () => {
      expect(profileTooltipFromValue({ name: "Ada", bio: "   " })).toEqual({
        bio: undefined,
        pinnedCount: 0,
      });
    });

    it("returns empty details for a projection without bio/elements", () => {
      // The self-view projection ({name, avatar}) carries no bio/elements.
      expect(profileTooltipFromValue({ name: "Ada", avatar: "🦊" })).toEqual({
        bio: undefined,
        pinnedCount: 0,
      });
    });

    it("returns empty details for non-object input", () => {
      expect(profileTooltipFromValue(undefined)).toEqual({
        bio: undefined,
        pinnedCount: 0,
      });
      expect(profileTooltipFromValue("nope")).toEqual({
        bio: undefined,
        pinnedCount: 0,
      });
    });
  });
});

describe("CFProfileBadge disposal handling", () => {
  // The resolve awaits `cell.resolveAsCell()`; a disposal race rejects it
  // with `AbortError` while the badge is still connected and its generation
  // unchanged, so only the runtime-signal guard distinguishes cancellation
  // from failure. The ambient runtime is cleared on logout, and the guard
  // reads the profile cell's own runtime instead, so the badge is given none.
  function badgeResolvingAborted(aborted: boolean): CFProfileBadge {
    const badge = new CFProfileBadge();
    markConnected(badge, true);
    badge.profile = {
      runtime: () => ({ signal: { aborted } }),
      resolveAsCell: () =>
        Promise.reject(new DOMException("aborted", "AbortError")),
    } as unknown as CFProfileBadge["profile"];
    return badge;
  }

  function resolve(badge: CFProfileBadge): Promise<void> {
    return badge.accessForTestingOnly.resolve();
  }

  function captureConsoleError(): { calls: unknown[][]; restore(): void } {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    return { calls, restore: () => (console.error = original) };
  }

  it("logs a resolve failure while the runtime is alive", async () => {
    const spy = captureConsoleError();
    try {
      await resolve(badgeResolvingAborted(false));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(1);
  });

  it("suppresses the resolve-failure log when the runtime is disposed", async () => {
    const spy = captureConsoleError();
    try {
      await resolve(badgeResolvingAborted(true));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(0);
  });
});
