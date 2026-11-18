import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  FrameReader,
  MAX_FRAME_BYTES,
  readDelivery,
  relayAddress,
} from "@commonfabric/github-webhooks/relay";

const ENCODER = new TextEncoder();

/** The request a webhook delivery of `event` carrying `body` arrives as. */
function request(event: string, body: string, type = "application/json") {
  return ENCODER.encode(
    "POST /webhook HTTP/1.1\r\n" +
      `x-GitHub-Event: ${event}\r\nContent-Type: ${type}\r\n\r\n${body}`,
  );
}

/** `request` as the relay frames it. */
function frameOf(request: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + request.length);
  new DataView(frame.buffer).setUint32(0, request.length);
  frame.set(request, 4);
  return frame;
}

/** A reader of a stream that carries `chunks` and then ends. */
function readerOf(...chunks: Uint8Array[]): FrameReader {
  return new FrameReader(ReadableStream.from(chunks));
}

/** The bytes of `frames`, one after another, in pieces of `piece` bytes. */
function pieces(frames: Uint8Array[], piece: number): Uint8Array[] {
  const all = new Uint8Array(frames.flatMap((frame) => [...frame]));
  const out: Uint8Array[] = [];
  for (let at = 0; at < all.length; at += piece) {
    out.push(all.slice(at, at + piece));
  }
  return out;
}

describe("relay", () => {
  describe("readDelivery()", () => {
    it("returns each delivery's event and parsed payload, then undefined at the end", async () => {
      const frames = readerOf(
        frameOf(request("push", '{"ref":"refs/heads/main"}')),
      );

      expect(await readDelivery(frames)).toEqual({
        delivery: { event: "push", payload: { ref: "refs/heads/main" } },
      });
      expect(await readDelivery(frames)).toBeUndefined();
    });

    it("returns deliveries whose frames arrive a byte at a time or several together", async () => {
      const frames = [1, 2, 3].map((n) =>
        frameOf(request("issues", `{"n":${n}}`))
      );

      for (const piece of [1, 7, 1000]) {
        const reader = readerOf(...pieces(frames, piece));
        const read = [];
        for (let i = 0; i < 3; i++) read.push(await readDelivery(reader));
        expect(read).toEqual([1, 2, 3].map((n) => ({
          delivery: { event: "issues", payload: { n } },
        })));
        expect(await readDelivery(reader)).toBeUndefined();
      }
    });

    it("returns the payload of a form-encoded body", async () => {
      const body = new URLSearchParams({ payload: '{"ref":"y"}' }).toString();

      expect(
        await readDelivery(readerOf(frameOf(
          request("issues", body, "application/x-www-form-urlencoded"),
        ))),
      ).toEqual({ delivery: { event: "issues", payload: { ref: "y" } } });
    });

    it("says why a frame carries no delivery", async () => {
      const unreadable: Array<[Uint8Array, string]> = [
        [
          ENCODER.encode("POST /webhook HTTP/1.1\r\n\r\n{}"),
          "a request named no event",
        ],
        [ENCODER.encode("no head end"), "a request had no end to its head"],
        [
          request("issues", "not json"),
          "a issues delivery could not be read: Unexpected token",
        ],
        [
          request("issues", "other=1", "application/x-www-form-urlencoded"),
          "a issues delivery could not be read: the form carries no payload",
        ],
      ];

      for (const [bytes, reason] of unreadable) {
        const frame = await readDelivery(readerOf(frameOf(bytes)));
        expect(frame?.delivery).toBeUndefined();
        expect(frame?.unreadable).toContain(reason);
      }
    });

    it("throws for a frame longer than the relay sends, and reads one as long", async () => {
      const prefix = (length: number) => {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, length);
        return bytes;
      };

      await expect(readDelivery(readerOf(prefix(MAX_FRAME_BYTES + 1))))
        .rejects.toThrow(
          `a frame of ${MAX_FRAME_BYTES + 1} bytes is longer than the relay`,
        );
      expect(await readDelivery(readerOf(prefix(MAX_FRAME_BYTES))))
        .toBeUndefined();
    });

    it("returns undefined for a stream that ends partway through a frame", async () => {
      const frame = frameOf(request("ping", "{}"));

      expect(await readDelivery(readerOf(frame.slice(0, 2)))).toBeUndefined();
      expect(await readDelivery(readerOf(frame.slice(0, 10))))
        .toBeUndefined();
    });
  });

  describe("FrameReader", () => {
    it("returns undefined from a read under way once it is cancelled", async () => {
      const reader = new FrameReader(new ReadableStream<Uint8Array>());
      const read = reader.read(4);

      reader.cancel();

      expect(await read).toBeUndefined();
      reader.release();
    });
  });

  describe("relayAddress()", () => {
    it("returns undefined for an empty address", () => {
      expect(relayAddress("")).toBeUndefined();
    });

    it("returns a connect that fails for an address with no port", async () => {
      await expect(relayAddress("relay.example")?.()).rejects.toThrow(
        "names no port",
      );
    });

    it("returns a connect that opens a connection to the host and port", async () => {
      using listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const accepted = listener.accept();

      const connect = relayAddress(`127.0.0.1:${listener.addr.port}`);
      if (connect === undefined) throw new Error("the address was refused");

      const connection = await connect();
      using server = await accepted;
      await server.write(frameOf(request("ping", "{}")));

      expect(await readDelivery(new FrameReader(connection.readable)))
        .toEqual({ delivery: { event: "ping", payload: {} } });
      connection.close();
    });

    it("returns a connect that gives up when its signal aborts", async () => {
      const connect = relayAddress("127.0.0.1:9");
      if (connect === undefined) throw new Error("the address was refused");

      await expect(connect(AbortSignal.abort(new Error("stopped"))))
        .rejects.toThrow("stopped");
    });
  });
});
