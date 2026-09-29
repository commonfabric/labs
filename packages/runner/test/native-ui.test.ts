import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { Runtime } from "../src/runtime.ts";
import { bindNativeUiControl } from "../src/native-ui.ts";
import {
  isRendererTrustedEvent,
  trustedEventMatchesUiContract,
} from "../src/cfc/ui-contract.ts";
import { stub } from "@std/testing/mock";

const signer = await Identity.fromPassphrase("native-ui-control-test");

describe("native UI controls", () => {
  it("authorizes the registered writer through a real handler transaction", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
    try {
      const { main } = await runtime.harness.compileAndEvaluateModules({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
          import { AuthoredByCurrentUser, TrustedActionWrite, Writable, handler, pattern } from "commonfabric";
          type AuthoredMessage = AuthoredByCurrentUser<TrustedActionWrite<{ body: string }, typeof save, "ChatSend", "ChatSendSurface">>;
          const save = handler<{body:string}, {items:Writable<{body:string}[]>}>((event, {items}) => {
            const record = new Writable<AuthoredMessage>();
            record.set({body:event.body});
            items.push(record);
          });
          export default pattern(() => {
            const items = new Writable<AuthoredMessage[]>([]);
            return {items, save:save({items})};
          });
        `,
        }],
      });
      const output = runtime.getCell<
        { items: { body: string }[]; save: unknown }
      >(signer.did(), "native-writer");
      const result = await runtime.runSynced(output, main!.default, {});
      const submit = bindNativeUiControl(result.key("save"), {
        surface: "ChatSendSurface",
        action: "ChatSend",
      });
      await submit({ body: "  exact text  " });
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

  it("captures the registered action and sends the displayed values with a host mark", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
    try {
      const stream = runtime.getCell(signer.did(), "native-control");
      const send = stub(stream, "send", () => Promise.resolve());
      const control = { surface: "ChatSendSurface", action: "ChatSend" };
      const submit = bindNativeUiControl(stream, control);
      control.action = "ChatDelete";
      const payload = {
        requestId: "one",
        version: { body: "  exact text  ", sentAt: 123n },
      };
      await submit(payload);
      const event = send.calls[0].args[0];
      if (typeof event !== "object" || event === null) {
        throw new Error("The control must send an event object.");
      }
      expect(event).toMatchObject(payload);
      expect(isRendererTrustedEvent(event)).toBe(true);
      const policy = {
        helper: "UiAction" as const,
        action: "ChatSend",
        trustedPattern: "ChatSendSurface",
        requiredEventIntegrity: ["ChatSendSurface"],
      };
      expect(trustedEventMatchesUiContract(event, policy)).toBe(true);
      expect(
        trustedEventMatchesUiContract(event, {
          ...policy,
          action: "ChatDelete",
        }),
      ).toBe(false);
      expect(trustedEventMatchesUiContract({ ...event }, policy)).toBe(false);
      expect(() =>
        bindNativeUiControl(stream, { surface: "", action: "ChatSend" })
      ).toThrow();
      send.restore();
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
