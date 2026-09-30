import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NAME } from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  CFProfileBadge,
  profileDisplayFromValue,
  profileTooltipFromValue,
} from "./index.ts";
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
    asSchema: () => ({
      subscribe: (cb: (val: unknown) => void) => {
        cb({ name: "Ada" });
        return () => {};
      },
    }),
    getCfcLabel: () => Promise.resolve(undefined),
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

    it("reports verified once a value and a label have both arrived", () => {
      // The boundary must not swallow the real case it is protecting.
      const el = new CFProfileBadge() as any;
      el._applyValue({ name: "Ada" });
      el._state = "verified";
      el._seal = identitySeal(OWNER_DID);
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
        asSchema: () => ({
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
  });

  describe("verification seal", () => {
    it("enters the verified state and derives the seal from the owner DID", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      el._deriveVerification(
        representsPrincipalLabel(OWNER_DID),
        el._resolveGeneration,
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
        asSchema: () => ({
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

    it("stays presented (no seal) when the label has no represents-principal atom", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      el._deriveVerification({
        version: 1,
        entries: [{ path: [], label: { integrity: ["profile-link"] } }],
      }, el._resolveGeneration);

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

  describe("profileDisplayFromValue", () => {
    it("prefers the profile's name field over the cell [NAME]", () => {
      // On main, profile-home's [NAME] is the static placeholder "Profile"
      // (profile-home.tsx:303); the editable `name` field is the real name.
      const val = {
        [NAME]: "Profile",
        name: "Ben",
        avatar: "https://example.com/ben.png",
      };
      expect(profileDisplayFromValue(val)).toEqual({
        name: "Ben",
        avatar: "https://example.com/ben.png",
      });
    });

    it("falls back to the cell [NAME] when the name field is blank", () => {
      const val = { [NAME]: "Ada Lovelace", name: "  ", avatar: "🦊" };
      expect(profileDisplayFromValue(val)).toEqual({
        name: "Ada Lovelace",
        avatar: "🦊",
      });
    });

    it("returns undefined fields for empty / non-object input", () => {
      expect(profileDisplayFromValue(undefined)).toEqual({
        name: undefined,
        avatar: undefined,
      });
      expect(profileDisplayFromValue("nope")).toEqual({
        name: undefined,
        avatar: undefined,
      });
      expect(profileDisplayFromValue({})).toEqual({
        name: undefined,
        avatar: undefined,
      });
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
  // _resolve awaits cell.resolveAsCell(); a disposal race rejects it with
  // AbortError while the badge is still connected and its generation unchanged,
  // so only the runtime-signal guard distinguishes cancellation from failure.
  function badgeThis(aborted: boolean): Record<string, unknown> {
    return {
      _resolveGeneration: 0,
      isConnected: true,
      // The ambient @consume runtime is cleared on logout; the guard reads the
      // profile cell's own runtime instead, so leave this undefined.
      runtime: undefined,
      profile: {
        runtime: () => ({ signal: { aborted } }),
        resolveAsCell: () =>
          Promise.reject(new DOMException("aborted", "AbortError")),
      },
      _cleanup: () => {},
      _applyValue: () => {},
    };
  }

  function resolve(fakeThis: Record<string, unknown>): Promise<void> {
    return (CFProfileBadge.prototype as unknown as {
      _resolve(this: unknown): Promise<void>;
    })._resolve.call(fakeThis);
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
      await resolve(badgeThis(false));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(1);
  });

  it("suppresses the resolve-failure log when the runtime is disposed", async () => {
    const spy = captureConsoleError();
    try {
      await resolve(badgeThis(true));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(0);
  });
});
