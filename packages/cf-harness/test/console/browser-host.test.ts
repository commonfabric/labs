import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { ConsoleBrowserHost } from "../../console/browser-host.ts";

const PAGE = { url: "https://shop.example/", title: "Shop" };

/** Everything `stream` delivers until it closes. */
const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    text += decoder.decode(chunk);
  }
  return text;
};

describe("console/browser-host", () => {
  describe("ConsoleBrowserHost", () => {
    it("admits only the token it was minted with", () => {
      const host = new ConsoleBrowserHost("the-token");

      expect(host.admits("the-token")).toBe(true);
      expect(host.admits("the-tokem")).toBe(false);
      expect(host.admits("the-token-longer")).toBe(false);
      expect(host.admits(undefined)).toBe(false);
    });

    it("delivers an operation sent before the host attached once it does", async () => {
      const host = new ConsoleBrowserHost("token");
      const answer = host.perform({ action: "reload" });

      const stream = host.attach()!;
      const reader = stream.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      const accepted = host.acceptResult("1", { status: "ok", page: PAGE });

      expect(first).toBe(
        'event: request\ndata: {"id":"1","operation":{"action":"reload"}}\n\n',
      );
      expect(accepted).toBe("accepted");
      expect(await answer).toEqual({ status: "ok", page: PAGE });
      await reader.cancel();
    });

    it("refuses a second attach, and any attach once the channel has ended", () => {
      const attached = new ConsoleBrowserHost("token");
      const closed = new ConsoleBrowserHost("token");
      attached.attach();
      closed.close();

      expect(attached.attach()).toBeUndefined();
      expect(closed.attach()).toBeUndefined();
    });

    it("returns session-ended for an operation sent after the turn ended", async () => {
      const host = new ConsoleBrowserHost("token");
      const outstanding = host.perform({
        action: "snapshot",
        interactive: false,
      });
      const stream = host.attach()!;

      host.close();

      expect(await outstanding).toEqual({
        status: "session-ended",
        message: "the turn has ended",
      });
      expect(await host.perform({ action: "reload" })).toEqual({
        status: "session-ended",
        message: "the turn has ended",
      });
      expect(await drain(stream)).toContain("event: close\ndata: {}\n\n");
    });

    it("rejects an operation with the signal's reason when the run aborts it", async () => {
      const host = new ConsoleBrowserHost("token");
      const controller = new AbortController();
      const answer = host.perform({ action: "reload" }, controller.signal);

      controller.abort(new Error("canceled"));

      await expect(answer).rejects.toThrow("canceled");
      expect(host.acceptResult("1", { status: "ok", page: PAGE })).toBe(
        "unknown",
      );
    });

    it("never delivers an operation the run withdrew before the host attached, and rejects an aborted signal outright", async () => {
      const host = new ConsoleBrowserHost("token");
      const controller = new AbortController();
      const withdrawn = host.perform({ action: "reload" }, controller.signal);
      controller.abort(new Error("canceled"));
      const refused = host.perform({ action: "back" }, controller.signal);
      const stream = host.attach()!;

      host.close();

      await expect(withdrawn).rejects.toThrow("canceled");
      await expect(refused).rejects.toThrow("canceled");
      expect(await drain(stream)).toBe("event: close\ndata: {}\n\n");
    });

    it("withdraws an operation the host holds when the run aborts it, and sends the host nothing more until it answers that one", async () => {
      const host = new ConsoleBrowserHost("token");
      const stream = host.attach()!;
      const controller = new AbortController();
      const withdrawn = host.perform({ action: "reload" }, controller.signal);
      controller.abort(new Error("canceled"));
      const next = host.perform({ action: "back" });
      host.ping(7);

      const acknowledged = host.acceptResult("1", {
        status: "failed",
        message: "stopped",
      });
      const answered = host.acceptResult("2", { status: "ok", page: PAGE });
      host.close();

      await expect(withdrawn).rejects.toThrow("canceled");
      expect(acknowledged).toBe("accepted");
      expect(answered).toBe("accepted");
      expect(await next).toEqual({ status: "ok", page: PAGE });
      expect(await drain(stream)).toBe(
        'event: request\ndata: {"id":"1","operation":{"action":"reload"}}\n\n' +
          'event: withdraw\ndata: {"id":"1"}\n\n' +
          ": 7\n\n" +
          'event: request\ndata: {"id":"2","operation":{"action":"back"}}\n\n' +
          "event: close\ndata: {}\n\n",
      );
    });

    it("takes no answer for an operation the host has not been sent, and sends it once the host attaches", async () => {
      const host = new ConsoleBrowserHost("token");
      const answer = host.perform({ action: "reload" });

      const early = host.acceptResult("1", { status: "ok", page: PAGE });
      const stream = host.attach()!;
      const accepted = host.acceptResult("1", { status: "ok", page: PAGE });
      host.close();

      expect(early).toBe("unknown");
      expect(accepted).toBe("accepted");
      expect(await answer).toEqual({ status: "ok", page: PAGE });
      expect(await drain(stream)).toContain(
        'event: request\ndata: {"id":"1","operation":{"action":"reload"}}',
      );
    });

    it("settles an operation as failed when the host answers with something that is not a result", async () => {
      const host = new ConsoleBrowserHost("token");
      const answer = host.perform({ action: "reload" });
      host.attach();

      const acceptance = host.acceptResult("1", { status: "ok" });

      expect(acceptance).toBe("invalid");
      expect(await answer).toEqual({
        status: "failed",
        message:
          "the browser host answered with something that is not a result",
      });
      expect(host.acceptResult("1", { status: "ok", page: PAGE })).toBe(
        "unknown",
      );
    });

    it("writes a comment frame to an attached stream on each ping", async () => {
      const host = new ConsoleBrowserHost("token");
      host.ping(1);
      const stream = host.attach()!;

      host.ping(2);
      host.close();

      expect(await drain(stream)).toBe(
        ": 2\n\nevent: close\ndata: {}\n\n",
      );
    });
  });
});
