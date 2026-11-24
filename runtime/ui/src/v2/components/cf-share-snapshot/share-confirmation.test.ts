/**
 * The confirmation that publishes a reviewed snapshot, driven by a click on
 * the dialog's Share button in a real document.
 */

// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { ContextProvider } from "@lit/context";
import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  createMockCellHandle,
  holdWrites,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { runtimeContext } from "../../runtime-context.ts";
import type { SnapshotShareRuntime } from "./cf-share-snapshot.ts";
import { CFShareSnapshot } from "./index.ts";

type Preview = Awaited<ReturnType<RuntimeClient["prepareSnapshotShare"]>>;

const reader = "did:key:verified-reader";

const preview: Preview = {
  id: "review-token",
  value: { title: "Solaris" },
  audience: { type: "https://commonfabric.org/cfc/atom/User", subject: reader },
};

/**
 * A component bound to a source, a recipient, and a result, with its review
 * prepared and its dialog open. `commit` answers the runtime's commit; every
 * commit it is asked for is recorded in `committed`.
 */
async function reviewing(
  commit: () => Promise<CellHandle> = () => Promise.resolve(released()),
) {
  const element = new CFShareSnapshot();
  const result = createMockCellHandle<unknown>(null, { id: "of:result" });
  const committed: string[] = [];
  const shared: string[] = [];
  const runtime: SnapshotShareRuntime = {
    prepareSnapshotShare: () => Promise.resolve(preview),
    commitSnapshotShare: (id) => {
      committed.push(id);
      return commit();
    },
    cancelSnapshotShare: () => Promise.resolve(),
  };
  element.source = createMockCellHandle<unknown>(preview.value);
  element.recipient = createMockCellHandle<unknown>({});
  element.result = result;
  element.runtime = runtime;
  element.addEventListener("cf-shared", (event) => shared.push(event.type));
  await mount(element);
  await element.accessForTestingOnly.prepare();
  return { element, result, committed, shared };
}

/** The released copy's handle, as the runtime hands it back. */
const released = () =>
  createMockCellHandle<unknown>(preview.value, { id: "of:released" });

const dialog = (element: CFShareSnapshot) =>
  element.shadowRoot!.querySelector("dialog")!;

const shareButton = (element: CFShareSnapshot) =>
  element.shadowRoot!.querySelector<HTMLButtonElement>("button.confirm")!;

/**
 * What the dialog shows of the review: the audience's identifier and the
 * exact data, both empty while it holds none.
 */
const reviewShown = (element: CFShareSnapshot) => ({
  audience: element.shadowRoot!.querySelector(".id")!.textContent!.trim(),
  data: element.shadowRoot!.querySelector("pre")!.textContent!,
});

/**
 * A click as a person's gesture delivers it: trusted, as a browser marks an
 * event it dispatches for a real gesture. happy-dom marks no event trusted.
 */
function personClick(): MouseEvent {
  const click = new MouseEvent("click", { bubbles: true, composed: true });
  Object.defineProperty(click, "isTrusted", { value: true });
  return click;
}

/**
 * Resolves once `promise` has settled. The component awaited it before the
 * test did, so what the component does on its settling has run by then, up
 * to the component's next wait.
 */
const settledAfter = (promise: Promise<unknown>) =>
  promise.then(() => {}, () => {});

describe("CFShareSnapshot", () => {
  afterEach(() => document.body.replaceChildren());

  describe("the runtime", () => {
    it("takes the runtime the host provides, and enables opening the review with it", async () => {
      const element = new CFShareSnapshot();
      element.source = createMockCellHandle<unknown>(preview.value);
      element.recipient = createMockCellHandle<unknown>({});
      element.result = createMockCellHandle<unknown>(null);
      const opener = () => element.shadowRoot!.querySelector("cf-button.open")!;
      await mount(element);
      expect(opener().hasAttribute("disabled")).toBe(true);

      const runtime = createMockCellHandle<unknown>(null).runtime();
      const host = document.createElement("div");
      new ContextProvider(host, {
        context: runtimeContext,
        initialValue: runtime,
      });
      document.body.append(host);
      host.append(element);
      await element.updateComplete;
      expect(element.runtime).toBe(runtime);
      expect(opener().hasAttribute("disabled")).toBe(false);
    });
  });

  describe("a person's click on Share", () => {
    it("publishes the reviewed copy, stores its link in the result, and fires `cf-shared`", async () => {
      const copy = released();
      const { element, result, committed, shared } = await reviewing(() =>
        Promise.resolve(copy)
      );
      expect(dialog(element).open).toBe(true);
      expect(reviewShown(element)).toEqual({
        audience: reader,
        data: JSON.stringify(preview.value, null, 2),
      });
      const announced = new Promise((resolve) =>
        element.addEventListener("cf-shared", resolve, { once: true })
      );

      shareButton(element).dispatchEvent(personClick());
      await announced;
      await element.updateComplete;

      expect(committed).toEqual([preview.id]);
      expect(writesSent(result).map((write) => write.value)).toEqual([
        copy.ref(),
      ]);
      expect(shared).toEqual(["cf-shared"]);
      expect(dialog(element).open).toBe(false);
      expect(reviewShown(element)).toEqual({ audience: "", data: "" });
      expect(shareButton(element).disabled).toBe(true);
      expect(element.shadowRoot!.querySelector("[role=alert]")).toBeNull();
    });

    it("publishes once when clicked again while the first is under way", async () => {
      const commit = Promise.withResolvers<CellHandle>();
      const { element, committed, shared } = await reviewing(() =>
        commit.promise
      );

      shareButton(element).dispatchEvent(personClick());
      shareButton(element).dispatchEvent(personClick());
      await element.updateComplete;
      expect(shareButton(element).disabled).toBe(true);
      expect(committed).toEqual([preview.id]);

      const announced = new Promise((resolve) =>
        element.addEventListener("cf-shared", resolve, { once: true })
      );
      commit.resolve(released());
      await announced;
      expect(shared).toEqual(["cf-shared"]);
    });

    it("publishes nothing for a click the page made", async () => {
      const { element, committed } = await reviewing();
      shareButton(element).dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      );
      expect(committed).toEqual([]);
      expect(dialog(element).open).toBe(true);
    });

    it("publishes nothing for a person's click that did not land on Share", async () => {
      const { element, committed } = await reviewing();
      await element.accessForTestingOnly.confirm(personClick());
      expect(committed).toEqual([]);
      expect(dialog(element).open).toBe(true);
    });

    it("publishes nothing once the review is canceled", async () => {
      const { element, committed } = await reviewing();
      dialog(element).dispatchEvent(new Event("cancel"));
      await element.updateComplete;
      expect(dialog(element).open).toBe(false);

      shareButton(element).dispatchEvent(personClick());
      expect(committed).toEqual([]);
    });
  });

  describe("a failed publication", () => {
    for (
      const [failure, message] of [
        [new Error("Audience changed"), "Audience changed"],
        ["opaque failure", "The snapshot could not be shared."],
      ] as const
    ) {
      it(`shows ${JSON.stringify(message)} and closes the review`, async () => {
        const commit = Promise.withResolvers<CellHandle>();
        const { element, result, shared } = await reviewing(() =>
          commit.promise
        );

        shareButton(element).dispatchEvent(personClick());
        commit.reject(failure);
        await settledAfter(commit.promise);
        await element.updateComplete;

        expect(element.shadowRoot!.querySelector("[role=alert]")?.textContent)
          .toBe(message);
        expect(dialog(element).open).toBe(false);
        expect(reviewShown(element)).toEqual({ audience: "", data: "" });
        expect(writesSent(result)).toEqual([]);
        expect(shared).toEqual([]);
      });
    }

    it("shows nothing when the component was rebound before it failed", async () => {
      const commit = Promise.withResolvers<CellHandle>();
      const { element } = await reviewing(() => commit.promise);

      shareButton(element).dispatchEvent(personClick());
      element.recipient = createMockCellHandle<unknown>({});
      await element.updateComplete;
      commit.reject(new Error("Audience changed"));
      await settledAfter(commit.promise);
      await element.updateComplete;

      expect(element.shadowRoot!.querySelector("[role=alert]")).toBeNull();
    });
  });

  describe("a component rebound while publishing", () => {
    it("stores nothing when rebound before the runtime answered", async () => {
      const commit = Promise.withResolvers<CellHandle>();
      const { element, result, shared } = await reviewing(() => commit.promise);

      shareButton(element).dispatchEvent(personClick());
      element.source = createMockCellHandle<unknown>({ title: "Changed" });
      await element.updateComplete;
      commit.resolve(released());
      await settledAfter(commit.promise);

      expect(writesSent(result)).toEqual([]);
      expect(shared).toEqual([]);
    });

    it("does not announce a link stored after it was rebound", async () => {
      const { element, result, shared } = await reviewing();
      const letWritesThrough = holdWrites(result);
      const stored = new Promise<{ writing: Promise<void> }>((resolve) => {
        const setStrict = result.setStrict.bind(result);
        result.setStrict = (value) => {
          const writing = setStrict(value);
          resolve({ writing });
          return writing;
        };
      });

      shareButton(element).dispatchEvent(personClick());
      const { writing } = await stored;
      element.audienceKind = "space";
      await element.updateComplete;
      letWritesThrough();
      await settledAfter(writing);

      expect(writesSent(result)).toHaveLength(1);
      expect(shared).toEqual([]);
    });
  });
});
