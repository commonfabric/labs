// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { CellHandle } from "@commonfabric/runtime-client";

import { CFProfileBadge } from "./index.ts";

const OWNER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const SPACE = "did:key:zSpace";
const PROFILE_ID = "of:profile";

/** The label a profile carries when `subject` wrote its name. */
const nameWrittenBy = (subject: string) => ({
  version: 1,
  entries: [{
    path: ["name"],
    label: { integrity: [{ kind: "represents-principal", subject }] },
  }],
});

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
 * Resolves once every promise the stand-in worker's answers settle has run:
 * they arrive as microtasks, so one macrotask boundary is past them all.
 */
const answersDelivered = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Resolves on the window's next animation frame. */
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * A stand-in for a bound profile link, which resolves to the document
 * `PROFILE_ID` at `path` in `SPACE`. Whether that document is its space's
 * root waits on `root`, the id the space's root links. The test delivers the
 * profile's value, or refuses it, through what this returns.
 */
function profileLink(
  {
    path = [],
    resolution = Promise.resolve(),
    root = Promise.resolve(PROFILE_ID),
  }: {
    path?: string[];
    resolution?: Promise<void>;
    root?: Promise<string>;
  } = {},
) {
  const subscribed = deferred<void>();
  let sink:
    | {
      callback: (
        value: unknown,
        label: unknown,
        delivery: { cfcLabelCurrent: boolean },
      ) => void;
      onRefused: () => void;
    }
    | undefined;
  const lifetime = new AbortController();
  const runtime = {
    signal: lifetime.signal,
    getCell: () =>
      Promise.resolve({
        sync: () => Promise.resolve(),
        key: () => ({
          resolveAsCell: async () => {
            const id = await root;
            return {
              ref: () => ({ path: [] }),
              space: () => SPACE,
              id: () => id,
            };
          },
        }),
      }),
  };
  // A field of the face, holding nothing.
  const field = {
    ref: () => ({ space: SPACE, id: "of:face", path: [] }),
    space: () => SPACE,
    id: () => "of:face",
    runtime: () => runtime,
    subscribe: (
      callback: (
        value: unknown,
        label: unknown,
        delivery: { cfcLabelCurrent: boolean },
      ) => void,
    ) => {
      callback(undefined, undefined, { cfcLabelCurrent: true });
      return () => {};
    },
  };
  const resolved = {
    ref: () => ({ path }),
    space: () => SPACE,
    id: () => PROFILE_ID,
    runtime: () => runtime,
    asSchema: () => ({
      key: () => field,
      subscribe: (
        callback: NonNullable<typeof sink>["callback"],
        options: { onRefused: () => void },
      ) => {
        sink = { callback, onRefused: options.onRefused };
        subscribed.resolve();
        return () => {};
      },
    }),
  };
  const link = {
    runtime: () => runtime,
    resolveAsCell: async () => {
      await resolution;
      return resolved;
    },
  };
  return {
    link: link as unknown as CellHandle,
    subscribed: subscribed.promise,
    deliver: (value: unknown, label?: unknown) =>
      sink!.callback(value, label, { cfcLabelCurrent: true }),
    refuse: () => sink!.onRefused(),
    /** Disposes of the runtime the profile is read through. */
    dispose: () => lifetime.abort(),
  };
}

/** A badge mounted over `profile`. */
const badgeOver = (
  profile: CellHandle | undefined,
  properties: Partial<CFProfileBadge> = {},
) => mount(Object.assign(new CFProfileBadge(), properties, { profile }));

/**
 * A mounted badge presenting `OWNER`'s verified profile, named Ada, once its
 * space's root has been read.
 */
async function verifiedBadge() {
  const profile = profileLink();
  const badge = await badgeOver(profile.link);
  await profile.subscribed;
  profile.deliver({ name: "Ada" }, nameWrittenBy(OWNER));
  await answersDelivered();
  await badge.updateComplete;
  return badge;
}

const shadow = (badge: CFProfileBadge) => badge.shadowRoot!;

const shownName = (badge: CFProfileBadge) =>
  shadow(badge).querySelector(".name")?.textContent?.trim();

const aura = (badge: CFProfileBadge) =>
  shadow(badge).querySelector<HTMLElement>(".aura")!;

/** Lays the badge's aura out as a box at (`left`, `top`) of `size` pixels. */
function layOutAura(
  badge: CFProfileBadge,
  left: number,
  top: number,
  size = 40,
) {
  aura(badge).getBoundingClientRect = () => new DOMRect(left, top, size, size);
}

const sheen = (badge: CFProfileBadge, name: string) =>
  badge.style.getPropertyValue(`--seal-${name}`);

/** Captures what `console.error` is given for the length of `run`. */
async function errorsLoggedDuring(run: () => Promise<void>): Promise<number> {
  using logged = stub(console, "error");
  await run();
  return logged.calls.length;
}

describe("cf-profile-badge-mounted", () => {
  afterEach(() => document.body.replaceChildren());

  describe("with no profile bound", () => {
    it("presents its fallback name, or an unknown profile", async () => {
      const unnamed = await badgeOver(undefined);
      const named = await badgeOver(undefined, { fallbackName: "Alex" });

      expect(shownName(unnamed)).toBe("Unknown profile");
      expect(shownName(named)).toBe("Alex");
    });
  });

  describe("a bound profile", () => {
    it("shows the profile's name once its value arrives", async () => {
      const profile = profileLink();
      const badge = await badgeOver(profile.link);
      await profile.subscribed;

      profile.deliver({ name: "Ada" });
      await badge.updateComplete;

      expect(shownName(badge)).toBe("Ada");
    });

    it("presents an unknown profile again once the profile is unbound", async () => {
      const profile = profileLink();
      const badge = await badgeOver(profile.link);
      await profile.subscribed;
      profile.deliver({ name: "Ada" });

      badge.profile = undefined;
      await badge.updateComplete;

      expect(shownName(badge)).toBe("Unknown profile");
    });

    it("shows a profile the worker refuses as withheld", async () => {
      const profile = profileLink();
      const badge = await badgeOver(profile.link, { fallbackName: "Alex" });
      await profile.subscribed;
      profile.deliver({ name: "Ada" });

      profile.refuse();
      await badge.updateComplete;

      expect(shownName(badge)).toBe("Content hidden by policy");
    });

    it("shows its bio and pinned-piece count in its tooltip", async () => {
      const profile = profileLink();
      const badge = await badgeOver(profile.link);
      await profile.subscribed;

      profile.deliver({ name: "Ada", bio: " Writes code. ", elements: [{}] });
      await badge.updateComplete;
      expect(shadow(badge).querySelector(".tooltip-bio")?.textContent?.trim())
        .toBe("Writes code.");
      expect(
        shadow(badge).querySelector(".tooltip-meta")?.textContent?.replace(
          /\s+/g,
          " ",
        ).trim(),
      ).toBe("📌 1 pinned piece");

      profile.deliver({ name: "Ada", elements: [{}, {}] });
      await badge.updateComplete;
      expect(shadow(badge).querySelectorAll(".tooltip-bio").length).toBe(0);
      expect(shadow(badge).querySelector(".tooltip-meta")?.textContent)
        .toContain("2 pinned pieces");
    });

    it("shows no tooltip for a profile with neither a bio nor pinned pieces", async () => {
      const profile = profileLink();
      const badge = await badgeOver(profile.link);
      await profile.subscribed;

      profile.deliver({ name: "Ada" });
      await badge.updateComplete;

      expect(shadow(badge).querySelectorAll(".tooltip").length).toBe(0);
    });
  });

  describe("navigability", () => {
    it("marks itself navigable when bound to a profile's root document", async () => {
      const profile = profileLink();
      const badge = await badgeOver(profile.link);
      await profile.subscribed;
      await badge.updateComplete;

      expect(badge.hasAttribute("data-navigable")).toBe(true);
    });

    it("is not navigable, and leaves Enter alone, when bound below a document's root", async () => {
      const profile = profileLink({ path: ["self"] });
      const badge = await badgeOver(profile.link);
      await profile.subscribed;
      await badge.updateComplete;
      const press = new KeyboardEvent("keydown", {
        key: "Enter",
        cancelable: true,
      });

      shadow(badge).querySelector(".badge")!.dispatchEvent(press);

      expect(badge.hasAttribute("data-navigable")).toBe(false);
      expect(press.defaultPrevented).toBe(false);
    });
  });

  it("logs nothing when its runtime is disposed while whether it is a profile is read", async () => {
    // A disposal cancels the read, which is not a failure to report.
    const root = deferred<string>();
    const profile = profileLink({ root: root.promise });
    await badgeOver(profile.link);
    await profile.subscribed;

    const logged = await errorsLoggedDuring(async () => {
      profile.dispose();
      root.reject(new DOMException("disposed", "AbortError"));
      await answersDelivered();
    });

    expect(logged).toBe(0);
  });

  describe("after it is removed from the page", () => {
    // A resolve still under way when the badge is removed answers into a
    // badge nobody sees; what it answers is dropped rather than shown or
    // logged.

    it("logs nothing when its binding then fails to resolve", async () => {
      const resolution = deferred<void>();
      const profile = profileLink({ resolution: resolution.promise });
      const badge = await badgeOver(profile.link);

      const logged = await errorsLoggedDuring(async () => {
        badge.remove();
        resolution.reject(new Error("worker went away"));
        await answersDelivered();
      });

      expect(logged).toBe(0);
    });

    it("logs nothing when whether it is a profile then cannot be read", async () => {
      const root = deferred<string>();
      const profile = profileLink({ root: root.promise });
      const badge = await badgeOver(profile.link);
      await profile.subscribed;

      const logged = await errorsLoggedDuring(async () => {
        badge.remove();
        root.reject(new Error("worker went away"));
        await answersDelivered();
      });

      expect(logged).toBe(0);
    });

    it("does not take up whether it is a profile when that arrives", async () => {
      const root = deferred<string>();
      const profile = profileLink({ root: root.promise });
      const badge = await badgeOver(profile.link);
      await profile.subscribed;

      badge.remove();
      root.resolve(PROFILE_ID);
      await answersDelivered();

      expect(badge.accessForTestingOnly.profileKnown).toBe(false);
    });

    it("does not show a refusal that arrives", async () => {
      const profile = profileLink();
      const badge = await badgeOver(profile.link);
      await profile.subscribed;
      profile.deliver({ name: "Ada" });
      await badge.updateComplete;

      badge.remove();
      profile.refuse();
      await badge.updateComplete;

      expect(shownName(badge)).toBe("Ada");
    });
  });

  describe("cursor sheen", () => {
    it("is driven each frame while the badge presents a verified profile", async () => {
      // The aura is laid out with no size, which the sheen treats as
      // offscreen: the frame writes a dark sheen.
      const badge = await verifiedBadge();
      expect(
        shadow(badge).querySelector(".badge")?.getAttribute("data-state"),
      ).toBe("verified");

      await nextFrame();

      expect(sheen(badge, "sheen-a")).toBe("0");
    });

    it("is not driven for a profile that is not verified", async () => {
      const profile = profileLink();
      const badge = await badgeOver(profile.link);
      await profile.subscribed;
      profile.deliver({ name: "Ada" });
      await answersDelivered();
      await badge.updateComplete;

      await nextFrame();

      expect(sheen(badge, "sheen-a")).toBe("");
    });

    it("is no longer driven once the badge is removed from the page", async () => {
      // A lit sheen is darkened by the next frame that drives it, which
      // writes its position.
      const badge = await verifiedBadge();
      layOutAura(badge, 100, 100);
      badge.updateSeal(120, 120, 0);

      badge.remove();
      badge.style.removeProperty("--seal-mx");
      await nextFrame();

      expect(sheen(badge, "mx")).toBe("");
    });

    describe("updateSeal()", () => {
      it("centers a full sheen on an aura the cursor is over", async () => {
        const badge = await verifiedBadge();
        layOutAura(badge, 100, 100);

        badge.updateSeal(120, 120, 0);

        expect(sheen(badge, "sheen-a")).toBe("1.000");
        expect(sheen(badge, "mx")).toBe("50.0%");
        expect(sheen(badge, "my")).toBe("50.0%");
      });

      it("moves the sheen toward the cursor, as far as the aura's edge", async () => {
        // The sheen reaches its edge for a cursor 1.9 aura-widths away.
        const badge = await verifiedBadge();
        layOutAura(badge, 100, 100);

        badge.updateSeal(120 + 38, 120 - 76, 0);
        expect(sheen(badge, "mx")).toBe("81.0%");
        expect(sheen(badge, "my")).toBe("-12.0%");

        badge.updateSeal(120 - 500, 120, 0);
        expect(sheen(badge, "mx")).toBe("-12.0%");
      });

      it("dims the sheen as the cursor moves away, to dark past 520 pixels", async () => {
        const badge = await verifiedBadge();
        layOutAura(badge, 100, 100);

        badge.updateSeal(120 + 260, 120, 0);
        expect(sheen(badge, "sheen-a")).toBe("0.388");

        badge.updateSeal(120 + 600, 120, 0);
        expect(sheen(badge, "sheen-a")).toBe("0.000");
      });

      it("writes nothing for a far cursor while the sheen is already dark", async () => {
        const badge = await verifiedBadge();
        layOutAura(badge, 100, 100);
        badge.updateSeal(120 + 600, 120, 0);
        badge.style.removeProperty("--seal-mx");

        badge.updateSeal(120 + 700, 120, 0);

        expect(sheen(badge, "mx")).toBe("");
      });

      it("turns the sheen's hue with time", async () => {
        const badge = await verifiedBadge();
        layOutAura(badge, 100, 100);

        badge.updateSeal(120, 120, 0);
        const before = Number(sheen(badge, "sheen-hue"));
        badge.updateSeal(120, 120, 1000);
        const after = Number(sheen(badge, "sheen-hue"));

        expect((after - before + 360) % 360).toBe(30);
      });

      it("darkens the sheen of an aura laid out below the viewport, once", async () => {
        const badge = await verifiedBadge();
        layOutAura(badge, 100, 100);
        badge.updateSeal(120, 120, 0);
        layOutAura(badge, 100, innerHeight + 100);

        badge.updateSeal(120, innerHeight + 120, 0);
        expect(sheen(badge, "sheen-a")).toBe("0");

        badge.style.removeProperty("--seal-sheen-a");
        badge.updateSeal(120, innerHeight + 120, 0);
        expect(sheen(badge, "sheen-a")).toBe("");
      });

      it("writes nothing before the badge has rendered", () => {
        const badge = new CFProfileBadge();

        badge.updateSeal(0, 0, 0);

        expect(sheen(badge, "sheen-a")).toBe("");
      });
    });

    describe("clearSeal()", () => {
      it("darkens the sheen, so that a far cursor then writes nothing", async () => {
        const badge = await verifiedBadge();
        layOutAura(badge, 100, 100);
        badge.updateSeal(120, 120, 0);

        badge.clearSeal();
        expect(sheen(badge, "sheen-a")).toBe("0");

        badge.style.removeProperty("--seal-mx");
        badge.updateSeal(120 + 600, 120, 0);
        expect(sheen(badge, "mx")).toBe("");
      });
    });
  });
});
