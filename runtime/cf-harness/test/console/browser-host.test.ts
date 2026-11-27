import { expect } from "@std/expect";

import { ConsoleBrowserHost } from "../../console/browser-host.ts";
import type { BrowserHostResult } from "../../src/contracts/browser-host.ts";
import { describe, it } from "@commonfabric/test-support/test";

const PAGE = { url: "https://shop.example/", title: "Shop" };

/** A page as a named session reports it. */
const NAMED_PAGE = {
  ...PAGE,
  site: "https://shop.example",
  sites: ["https://shop.example"],
};

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
      const answer = host.perform({ operation: { action: "reload" } });

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
        operation: {
          action: "snapshot",
          interactive: false,
        },
      });
      const stream = host.attach()!;

      host.close();

      expect(await outstanding).toEqual({
        status: "session-ended",
        message: "the turn has ended",
      });
      expect(await host.perform({ operation: { action: "reload" } })).toEqual({
        status: "session-ended",
        message: "the turn has ended",
      });
      expect(await drain(stream)).toContain("event: close\ndata: {}\n\n");
    });

    it("rejects an operation with the signal's reason when the run aborts it", async () => {
      const host = new ConsoleBrowserHost("token");
      const controller = new AbortController();
      const answer = host.perform(
        { operation: { action: "reload" } },
        controller.signal,
      );

      controller.abort(new Error("canceled"));

      await expect(answer).rejects.toThrow("canceled");
      expect(host.acceptResult("1", { status: "ok", page: PAGE })).toBe(
        "unknown",
      );
    });

    it("never delivers an operation the run withdrew before the host attached, and rejects an aborted signal outright", async () => {
      const host = new ConsoleBrowserHost("token");
      const controller = new AbortController();
      const withdrawn = host.perform(
        { operation: { action: "reload" } },
        controller.signal,
      );
      controller.abort(new Error("canceled"));
      const refused = host.perform(
        { operation: { action: "back" } },
        controller.signal,
      );
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
      const withdrawn = host.perform(
        { operation: { action: "reload" } },
        controller.signal,
      );
      controller.abort(new Error("canceled"));
      const next = host.perform({ operation: { action: "back" } });
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
      const answer = host.perform({ operation: { action: "reload" } });

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
      const malformed: readonly unknown[] = [
        { status: "ok" },
        "ok",
        null,
        [],
        { status: "ok", page: { url: "https://shop.example/", title: 7 } },
        { status: "ok", page: PAGE, text: 7 },
        { status: "ok", page: PAGE, handoff: "maybe" },
        { status: "ok", page: PAGE, image: { mediaType: "image/gif" } },
        { status: "stale-ref" },
        { status: "gone", message: "the page went away" },
        { status: "failed", message: "no", page: "https://shop.example/" },
      ];
      for (const result of malformed) {
        const host = new ConsoleBrowserHost("token");
        const answer = host.perform({ operation: { action: "reload" } });
        host.attach();

        const acceptance = host.acceptResult("1", result);

        expect(acceptance).toBe("invalid");
        expect(await answer).toEqual({
          status: "failed",
          message:
            "the browser host answered with something that is not a result",
        });
        expect(host.acceptResult("1", { status: "ok", page: PAGE })).toBe(
          "unknown",
        );
      }
    });

    it("settles an operation with each well-formed answer as the host gave it", async () => {
      const results: readonly BrowserHostResult[] = [
        { status: "ok", page: PAGE },
        {
          status: "ok",
          page: PAGE,
          text: '- button "Buy" [ref=e1]',
          image: { mediaType: "image/png", base64: "iVBORw0KGgo=" },
          handoff: "declined",
        },
        { status: "stale-ref", message: "take a new snapshot" },
        { status: "failed", message: "the click missed", page: PAGE },
      ];
      for (const result of results) {
        const host = new ConsoleBrowserHost("token");
        const answer = host.perform({ operation: { action: "reload" } });
        host.attach();

        expect(host.acceptResult("1", result)).toBe("accepted");
        expect(await answer).toEqual(result);
      }
    });

    it("returns unknown for an answer naming no operation by a string id", async () => {
      const host = new ConsoleBrowserHost("token");
      const answer = host.perform({ operation: { action: "reload" } });
      host.attach();

      expect(host.acceptResult(1, { status: "ok", page: PAGE })).toBe(
        "unknown",
      );
      expect(host.acceptResult("1", { status: "ok", page: PAGE })).toBe(
        "accepted",
      );
      expect(await answer).toEqual({ status: "ok", page: PAGE });
    });

    it("tells the host once when the turn ends, however often it is closed", async () => {
      const host = new ConsoleBrowserHost("token");
      const stream = host.attach()!;

      host.close();
      host.close();

      expect(await drain(stream)).toBe("event: close\ndata: {}\n\n");
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

    describe("sessions", () => {
      it("frames each operation with its session, delivering other sessions' operations while one owes an acknowledgment of a withdrawal, each in order", async () => {
        const host = new ConsoleBrowserHost("token");
        const stream = host.attach()!;
        const controller = new AbortController();
        const withdrawn = host.perform(
          { session: "a", operation: { action: "reload" } },
          controller.signal,
        );
        controller.abort(new Error("canceled"));
        const a2 = host.perform({
          session: "a",
          operation: { action: "back" },
        });
        const b1 = host.perform({
          session: "b",
          operation: { action: "back" },
        });
        const unnamed = host.perform({ operation: { action: "forward" } });
        const a3 = host.perform({
          session: "a",
          operation: { action: "forward" },
        });

        const answeredEarly = host.acceptResult("3", {
          status: "ok",
          page: NAMED_PAGE,
        });
        const heldBack = host.acceptResult("2", {
          status: "ok",
          page: NAMED_PAGE,
        });
        host.acceptResult("4", { status: "ok", page: PAGE });
        host.acceptResult("1", { status: "failed", message: "stopped" });
        host.acceptResult("2", { status: "ok", page: NAMED_PAGE });
        host.acceptResult("5", { status: "ok", page: NAMED_PAGE });
        host.close();

        await expect(withdrawn).rejects.toThrow("canceled");
        expect(answeredEarly).toBe("accepted");
        expect(heldBack).toBe("unknown");
        expect(await Promise.all([a2, b1, unnamed, a3])).toEqual([
          { status: "ok", page: NAMED_PAGE },
          { status: "ok", page: NAMED_PAGE },
          { status: "ok", page: PAGE },
          { status: "ok", page: NAMED_PAGE },
        ]);
        expect(await drain(stream)).toBe(
          'event: request\ndata: {"id":"1","session":"a","operation":{"action":"reload"}}\n\n' +
            'event: withdraw\ndata: {"id":"1"}\n\n' +
            'event: request\ndata: {"id":"3","session":"b","operation":{"action":"back"}}\n\n' +
            'event: request\ndata: {"id":"4","operation":{"action":"forward"}}\n\n' +
            'event: request\ndata: {"id":"2","session":"a","operation":{"action":"back"}}\n\n' +
            'event: request\ndata: {"id":"5","session":"a","operation":{"action":"forward"}}\n\n' +
            "event: close\ndata: {}\n\n",
        );
      });

      it("sends a session-list while the unnamed session owes an acknowledgment of a withdrawal", async () => {
        const host = new ConsoleBrowserHost("token");
        const stream = host.attach()!;
        const controller = new AbortController();
        const withdrawn = host.perform(
          { operation: { action: "reload" } },
          controller.signal,
        );
        controller.abort(new Error("canceled"));
        const next = host.perform({ operation: { action: "back" } });
        const list = host.perform({ operation: { action: "session-list" } });

        const listed = host.acceptResult("3", { status: "ok", sessions: [] });
        const early = host.acceptResult("2", { status: "ok", page: PAGE });
        host.close();

        await expect(withdrawn).rejects.toThrow("canceled");
        expect(listed).toBe("accepted");
        expect(early).toBe("unknown");
        expect(await list).toEqual({ status: "ok", sessions: [] });
        expect(await next).toMatchObject({ status: "session-ended" });
        expect(await drain(stream)).toBe(
          'event: request\ndata: {"id":"1","operation":{"action":"reload"}}\n\n' +
            'event: withdraw\ndata: {"id":"1"}\n\n' +
            'event: request\ndata: {"id":"3","operation":{"action":"session-list"}}\n\n' +
            "event: close\ndata: {}\n\n",
        );
      });

      it("returns invalid for a malformed request, and sends the host nothing", async () => {
        const host = new ConsoleBrowserHost("token");
        const stream = host.attach()!;

        const unnamedOpen = await host.perform({
          operation: {
            action: "session-open",
            kind: "read-only",
            url: "https://shop.example/",
          },
        });
        const badName = await host.perform({
          session: "",
          operation: { action: "reload" },
        });
        host.close();

        expect(unnamedOpen).toEqual({
          status: "invalid",
          message: "`session-open` names a session",
        });
        expect(badName).toMatchObject({ status: "invalid" });
        expect(await drain(stream)).toBe("event: close\ndata: {}\n\n");
      });

      it("checks each answer against the operation and session it answers", async () => {
        const host = new ConsoleBrowserHost("token");
        host.attach();
        const named = host.perform({
          session: "a",
          operation: { action: "reload" },
        });
        const closed = host.perform({
          session: "b",
          operation: { action: "session-close" },
        });

        // A page from a named session reports its sites.
        expect(host.acceptResult("1", { status: "ok", page: PAGE })).toBe(
          "invalid",
        );
        expect(host.acceptResult("2", { status: "ok" })).toBe("accepted");
        host.close();

        expect(await named).toMatchObject({ status: "failed" });
        expect(await closed).toEqual({ status: "ok" });
      });
    });
  });
});
