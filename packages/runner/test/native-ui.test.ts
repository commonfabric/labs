import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import {
  isRendererTrustedEvent,
  isTrustedGesture,
  trustedEventMatchesUiContract,
} from "../src/cfc/ui-contract.ts";
import { bindNativeUiControl } from "../src/native-ui.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("native-ui-control-test");

/** The `UiAction` contract a `TrustedActionWrite` for `ChatSend` declares. */
const chatSendPolicy = {
  helper: "UiAction" as const,
  action: "ChatSend",
  trustedPattern: "ChatSendSurface",
  requiredEventIntegrity: ["ChatSendSurface"],
};

/** A pattern whose one writer is gated on `ChatSend` from `ChatSendSurface`. */
const chatPatternSource = `
  import {
    AuthoredByCurrentUser,
    handler,
    pattern,
    TrustedActionWrite,
    Writable,
  } from "commonfabric";

  type AuthoredMessage = AuthoredByCurrentUser<
    TrustedActionWrite<{ body: string }, typeof save, "ChatSend", "ChatSendSurface">
  >;

  const save = handler<{ body: string }, { items: Writable<{ body: string }[]> }>(
    (event, { items }) => {
      const record = new Writable<AuthoredMessage>();
      record.set({ body: event.body });
      items.push(record);
    },
  );

  export default pattern(() => {
    const items = new Writable<AuthoredMessage[]>([]);
    return { items, save: save({ items }) };
  });
`;

/** Binds a spy stream and returns it with the function bound to it. */
const bindToSpy = (control: { surface: string; action: string }) => {
  const send = spy((_event: unknown) => {});
  const submit = bindNativeUiControl<Record<string, unknown>>(
    { send },
    control,
  );
  return { send, submit };
};

/** The one event `send` was called with. */
const sentEvent = (send: { calls: { args: unknown[] }[] }) => {
  expect(send.calls.length).toBe(1);
  return send.calls[0].args[0];
};

describe("native-ui", () => {
  describe("bindNativeUiControl()", () => {
    it("commits the write its handler makes, authored by the actor, and the runtime refuses one bound to another action", async () => {
      const storage = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: storage,
      });
      try {
        const { main } = await runtime.harness.compileAndEvaluateModules({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: chatPatternSource }],
        });
        const output = runtime.getCell<
          { items: { body: string }[]; save: unknown }
        >(signer.did(), "native-writer");
        const result = await runtime.runSynced(output, main!.default, {});

        const wrongAction = bindNativeUiControl(result.key("save"), {
          surface: "ChatSendSurface",
          action: "ChatDelete",
        });
        wrongAction({ body: "refused" });
        await runtime.settled();

        const submit = bindNativeUiControl(result.key("save"), {
          surface: "ChatSendSurface",
          action: "ChatSend",
        });
        submit({ body: "  exact text  " });
        await runtime.settled();
        await result.pull();

        expect(result.key("items").get()).toEqual([{ body: "  exact text  " }]);
        const label = cfcLabelViewForCell(
          result.key("items").key(0).resolveAsCell(),
        );
        expect(label?.entries.flatMap((entry) => entry.label.integrity ?? []))
          .toContainEqual({ kind: "authored-by", subject: signer.did() });
      } finally {
        await runtime.dispose();
        await storage.close();
      }
    });

    it("sends the payload's fields, with native provenance for the bound surface and action", () => {
      const { send, submit } = bindToSpy({
        surface: "ChatSendSurface",
        action: "ChatSend",
      });
      const payload = {
        requestId: "one",
        version: { body: "  exact text  ", sentAt: 123n },
      };
      submit(payload);

      const event = sentEvent(send);
      expect(event).toStrictEqual({
        ...payload,
        provenance: {
          origin: "native",
          trusted: true,
          ui: {
            pattern: "ChatSendSurface",
            eventIntegrity: ["ChatSendSurface"],
            uiContractDataset: { uiAction: "ChatSend" },
          },
        },
      });
      expect(event).not.toBe(payload);
      expect(isRendererTrustedEvent(event)).toBe(true);
      expect(trustedEventMatchesUiContract(event, chatSendPolicy)).toBe(true);
    });

    it("sends a payload typed by an interface, which has no index signature", () => {
      // An interface has no index signature, so the binding below type-checks
      // only under a bound that admits one. `deno task check` holds that half
      // of the case, and the run holds the rest.

      interface ChatSendRequest {
        body: string;
        replyTo?: string;
      }

      const send = spy((_event: unknown) => {});
      const submit: (payload: ChatSendRequest) => void = bindNativeUiControl<
        ChatSendRequest
      >({ send }, { surface: "ChatSendSurface", action: "ChatSend" });
      const payload: ChatSendRequest = { body: "hello", replyTo: "one" };
      submit(payload);

      const event = sentEvent(send);
      expect(event).toMatchObject({ body: "hello", replyTo: "one" });
      expect(trustedEventMatchesUiContract(event, chatSendPolicy)).toBe(true);
    });

    it("keeps the surface and action it was bound with when the descriptor changes afterward", () => {
      const control = { surface: "ChatSendSurface", action: "ChatSend" };
      const { send, submit } = bindToSpy(control);
      control.surface = "ChatDeleteSurface";
      control.action = "ChatDelete";
      submit({ body: "hello" });

      const event = sentEvent(send);
      expect(trustedEventMatchesUiContract(event, chatSendPolicy)).toBe(true);
      expect(
        trustedEventMatchesUiContract(event, {
          ...chatSendPolicy,
          action: "ChatDelete",
        }),
      ).toBe(false);
      expect(
        trustedEventMatchesUiContract(event, {
          ...chatSendPolicy,
          trustedPattern: "ChatDeleteSurface",
          requiredEventIntegrity: ["ChatDeleteSurface"],
        }),
      ).toBe(false);
    });

    it("replaces a `provenance` field the payload carries", () => {
      const { send, submit } = bindToSpy({
        surface: "ChatSendSurface",
        action: "ChatSend",
      });
      submit({
        body: "hello",
        provenance: {
          origin: "native",
          trusted: true,
          ui: {
            pattern: "ChatDeleteSurface",
            eventIntegrity: ["ChatDeleteSurface"],
            uiContractDataset: { uiAction: "ChatDelete" },
          },
        },
      });

      const event = sentEvent(send);
      expect(trustedEventMatchesUiContract(event, chatSendPolicy)).toBe(true);
      expect(
        trustedEventMatchesUiContract(event, {
          helper: "UiAction",
          action: "ChatDelete",
          trustedPattern: "ChatDeleteSurface",
          requiredEventIntegrity: ["ChatDeleteSurface"],
        }),
      ).toBe(false);
    });

    it("sends an event that matches no contract once copied, and is not a trusted gesture", () => {
      const { send, submit } = bindToSpy({
        surface: "ChatSendSurface",
        action: "ChatSend",
      });
      submit({ body: "hello" });

      const event = sentEvent(send) as Record<string, unknown>;
      expect(trustedEventMatchesUiContract(event, chatSendPolicy)).toBe(true);
      expect(trustedEventMatchesUiContract({ ...event }, chatSendPolicy))
        .toBe(false);
      expect(isTrustedGesture(event)).toBe(false);
    });

    it("throws given a blank surface or action, and sends nothing", () => {
      const send = spy((_event: unknown) => {});
      for (
        const control of [
          { surface: "", action: "ChatSend" },
          { surface: " ", action: "ChatSend" },
          { surface: "ChatSendSurface", action: "" },
          { surface: "ChatSendSurface", action: "\t" },
        ]
      ) {
        expect(() => bindNativeUiControl({ send }, control)).toThrow(
          "A native UI control requires a surface and an action.",
        );
      }
      expect(send.calls.length).toBe(0);
    });
  });
});
