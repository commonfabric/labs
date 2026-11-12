import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  discardBuffer,
  handleHasBufferedContent,
  handleHasPendingChanges,
  HandleMap,
  MAX_VIRTUAL_FILE_SIZE,
  validateVirtualFileRange,
} from "./handles.ts";
import { O_RDONLY, O_RDWR, O_WRONLY } from "./platform.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("HandleMap marks empty truncates as pending without treating them as buffered writes", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));

  assertEquals(handleHasPendingChanges(handles.get(fh)), false);

  handles.truncate(fh, 0);

  const handle = handles.get(fh);
  assertEquals(handle?.buffer.length, 0);
  assertEquals(handle?.dirty, false);
  assertEquals(handle?.truncatePending, true);
  assertEquals(handleHasPendingChanges(handle), true);
  assertEquals(handleHasBufferedContent(handle), true);
});

Deno.test("HandleMap clears pending truncates when content arrives", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));

  handles.truncate(fh, 0);
  handles.write(fh, encoder.encode("world"), 0);

  const handle = handles.get(fh);
  assertEquals(new TextDecoder().decode(handle?.buffer), "world");
  assertEquals(handle?.dirty, true);
  assertEquals(handle?.truncatePending, false);
  assertEquals(handleHasPendingChanges(handle), true);
});

Deno.test("HandleMap clears sibling pending truncates when content arrives", () => {
  const handles = new HandleMap();
  const writer = handles.open(1n, O_RDWR, encoder.encode("hello"));
  const duplicate = handles.open(1n, O_RDWR, encoder.encode("hello"));

  handles.truncateByIno(1n, 0, writer);
  handles.truncateByIno(1n, 0, duplicate);
  handles.write(writer, encoder.encode("fresh"), 0);

  const writerHandle = handles.get(writer);
  assertEquals(new TextDecoder().decode(writerHandle?.buffer), "fresh");
  assertEquals(writerHandle?.dirty, true);
  assertEquals(writerHandle?.truncatePending, false);
  assertEquals(handleHasPendingChanges(writerHandle), true);

  const duplicateHandle = handles.get(duplicate);
  assertEquals(duplicateHandle?.dirty, false);
  assertEquals(duplicateHandle?.truncatePending, false);
  assertEquals(handleHasPendingChanges(duplicateHandle), false);
});

Deno.test("HandleMap truncates every open handle for an inode", () => {
  const handles = new HandleMap();
  const first = handles.open(1n, O_RDWR, encoder.encode("first"));
  const second = handles.open(1n, O_RDWR, encoder.encode("second"));
  const other = handles.open(2n, O_RDWR, encoder.encode("other"));

  handles.write(first, encoder.encode("stale"), 0);

  handles.truncateByIno(1n, 0, first);

  for (const fh of [first, second]) {
    const handle = handles.get(fh);
    assertEquals(handle?.buffer.length, 0);
    assertEquals(handle?.dirty, false);
    assertEquals(handle?.truncatePending, fh === first);
  }
  assertEquals(new TextDecoder().decode(handles.get(other)?.buffer), "other");

  handles.write(first, encoder.encode("fresh"), 0);
  const firstHandle = handles.get(first);
  assertEquals(new TextDecoder().decode(firstHandle?.buffer), "fresh");
  assertEquals(firstHandle?.dirty, true);
  assertEquals(firstHandle?.truncatePending, false);
});

Deno.test("HandleMap only marks the truncating handle pending when provided", () => {
  const handles = new HandleMap();
  const stale = handles.open(1n, O_RDWR, encoder.encode("stale"));
  const truncating = handles.open(1n, O_RDWR, encoder.encode("current"));

  handles.write(stale, encoder.encode("dirty"), 0);

  handles.truncateByIno(1n, 0, truncating);

  const staleHandle = handles.get(stale);
  assertEquals(staleHandle?.buffer.length, 0);
  assertEquals(staleHandle?.dirty, false);
  assertEquals(staleHandle?.truncatePending, false);
  assertEquals(handleHasPendingChanges(staleHandle), false);
  assertEquals(handleHasBufferedContent(staleHandle), true);

  const truncatingHandle = handles.get(truncating);
  assertEquals(truncatingHandle?.buffer.length, 0);
  assertEquals(truncatingHandle?.dirty, false);
  assertEquals(truncatingHandle?.truncatePending, true);
  assertEquals(handleHasPendingChanges(truncatingHandle), true);
  assertEquals(handleHasBufferedContent(truncatingHandle), true);
});

Deno.test("HandleMap rejects invalid and oversized write allocations", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDWR, new Uint8Array(0));

  expect(() => handles.write(fh, encoder.encode("x"), -1)).toThrow(
    RangeError,
  );
  expect(() => handles.write(fh, encoder.encode("x"), MAX_VIRTUAL_FILE_SIZE))
    .toThrow(RangeError);

  const handle = handles.get(fh);
  assertEquals(handle?.buffer.length, 0);
  assertEquals(handle?.dirty, false);
});

Deno.test("HandleMap rejects oversized truncates without resizing buffers", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));

  expect(() => handles.truncate(fh, MAX_VIRTUAL_FILE_SIZE + 1)).toThrow(
    RangeError,
  );
  expect(() => handles.truncate(fh, -1)).toThrow(RangeError);
  assertEquals(new TextDecoder().decode(handles.get(fh)?.buffer), "hello");
});

Deno.test("validateVirtualFileRange classifies invalid and too-large ranges", () => {
  assertEquals(validateVirtualFileRange(-1, 1), {
    ok: false,
    reason: "invalid",
  });
  assertEquals(validateVirtualFileRange(0, -1), {
    ok: false,
    reason: "invalid",
  });
  assertEquals(validateVirtualFileRange(MAX_VIRTUAL_FILE_SIZE, 1), {
    ok: false,
    reason: "too-large",
  });
  assertEquals(validateVirtualFileRange(MAX_VIRTUAL_FILE_SIZE - 1, 1), {
    ok: true,
  });
});

Deno.test("HandleMap stores stable write targets on open handles", () => {
  const handles = new HandleMap();
  const writeTarget = { kind: "value", target: { jsonPath: ["title"] } };
  const fh = handles.open(
    1n,
    O_RDWR,
    encoder.encode("hello"),
    { writeTarget },
  );

  assertEquals(handles.get(fh)?.writeTarget, writeTarget);
});

Deno.test("HandleMap tracks CFC truncate and write authorization separately", () => {
  const handles = new HandleMap();
  const fh = handles.open(
    1n,
    O_RDWR,
    encoder.encode("hello"),
    { cfcAuthorizedOperations: ["truncate"] },
  );

  assertEquals(handles.hasCfcAuthorization(fh, "truncate"), true);
  assertEquals(handles.hasCfcAuthorization(fh, "write"), false);

  handles.authorizeCfcOperation(fh, "write");

  assertEquals(handles.hasCfcAuthorization(fh, "truncate"), true);
  assertEquals(handles.hasCfcAuthorization(fh, "write"), true);
});

Deno.test("HandleMap buffers a read-only handle from a read snapshot", () => {
  const handles = new HandleMap();
  const snapshot = encoder.encode("generated once");
  const fh = handles.open(1n, O_RDONLY, undefined, { readSnapshot: snapshot });

  const handle = handles.get(fh);
  // A read-only handle is otherwise unbuffered, and reads fall through to the
  // node — which would render again and could disagree with this descriptor.
  assertEquals(handleHasBufferedContent(handle), true);
  assertEquals(handle?.buffer, snapshot);
  // Copied, so a renderer reusing its array cannot change the served bytes.
  assertEquals(handle?.buffer === snapshot, false);
  assertEquals(handleHasPendingChanges(handle), false);
});

Deno.test("HandleMap leaves a read-only handle unbuffered without a snapshot", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDONLY, encoder.encode("stored"));
  assertEquals(handleHasBufferedContent(handles.get(fh)), false);
});

Deno.test("HandleMap carries a snapshot's publish time on the handle", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDONLY, undefined, {
    readSnapshot: encoder.encode("v1"),
    readSnapshotMtime: 1_700_000_000_500,
  });
  // A getattr on this handle reports both the snapshot's size and this time, so
  // its attributes describe one render.
  assertEquals(handles.get(fh)?.readSnapshotMtime, 1_700_000_000_500);
});

Deno.test("HandleMap ignores a snapshot time without a snapshot", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDONLY, encoder.encode("stored"), {
    readSnapshotMtime: 1_700_000_000_500,
  });
  assertEquals(handles.get(fh)?.readSnapshotMtime, undefined);
});

describe("HandleMap", () => {
  describe("instance members", () => {
    describe("authorizeCfcOperation()", () => {
      it("returns `true` and records the operation for an open handle", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));

        expect(handles.authorizeCfcOperation(fh, "write")).toBe(true);
        expect(handles.hasCfcAuthorization(fh, "write")).toBe(true);
      });

      it("returns `false` for a closed handle, leaving it unauthorized", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));
        handles.close(fh);

        expect(handles.authorizeCfcOperation(fh, "write")).toBe(false);
        expect(handles.hasCfcAuthorization(fh, "write")).toBe(false);
        expect(handles.get(fh)).toBeUndefined();
      });
    });

    describe("write()", () => {
      it("throws for a closed handle without reopening it", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));
        handles.close(fh);

        expect(() => handles.write(fh, encoder.encode("x"), 0)).toThrow(
          `No open file handle ${fh}`,
        );
        expect(handles.get(fh)).toBeUndefined();
      });

      it("throws for a read-only handle, leaving its buffer as it was", () => {
        const handles = new HandleMap();
        const reader = handles.open(1n, O_RDONLY, encoder.encode("hello"));

        expect(() => handles.write(reader, encoder.encode("x"), 0)).toThrow(
          `File handle ${reader} is not open for writing`,
        );
        expect(handleHasBufferedContent(handles.get(reader))).toBe(false);
      });

      it("starts a buffer a flush discarded again from empty", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_WRONLY, encoder.encode("hello"));
        discardBuffer(handles.get(fh)!);

        handles.write(fh, encoder.encode("hi"), 0);

        const handle = handles.get(fh);
        expect(decoder.decode(handle?.buffer)).toBe("hi");
        expect(handleHasPendingChanges(handle)).toBe(true);
      });
    });

    describe("truncateByIno()", () => {
      it("throws for a read-only pending handle, leaving every buffer as it was", () => {
        const handles = new HandleMap();
        const writer = handles.open(1n, O_RDWR, encoder.encode("hello"));
        const reader = handles.open(1n, O_RDONLY, encoder.encode("hello"));

        expect(() => handles.truncateByIno(1n, 0, reader)).toThrow(
          `File handle ${reader} is not open for writing`,
        );
        expect(decoder.decode(handles.get(writer)?.buffer)).toBe("hello");
        expect(handles.get(writer)?.version).toBe(0);
      });

      it("throws for a size past the limit, leaving every buffer as it was", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));

        expect(() => handles.truncateByIno(1n, MAX_VIRTUAL_FILE_SIZE + 1, fh))
          .toThrow(RangeError);
        expect(() => handles.truncateByIno(1n, -1, fh)).toThrow(RangeError);
        const handle = handles.get(fh);
        expect(decoder.decode(handle?.buffer)).toBe("hello");
        expect(handle?.version).toBe(0);
        expect(handleHasPendingChanges(handle)).toBe(false);
      });

      it("cuts every buffer of the inode to a shorter size, leaving other inodes alone", () => {
        const handles = new HandleMap();
        const first = handles.open(1n, O_RDWR, encoder.encode("hello"));
        const second = handles.open(1n, O_RDWR, encoder.encode("howdy"));
        const other = handles.open(2n, O_RDWR, encoder.encode("other"));

        handles.truncateByIno(1n, 2, first);

        expect(decoder.decode(handles.get(first)?.buffer)).toBe("he");
        expect(decoder.decode(handles.get(second)?.buffer)).toBe("ho");
        expect(handles.get(first)?.dirty).toBe(true);
        expect(handles.get(second)?.dirty).toBe(false);
        expect(decoder.decode(handles.get(other)?.buffer)).toBe("other");
        expect(handles.get(other)?.dirty).toBe(false);
        expect(handles.get(other)?.version).toBe(0);
      });

      it("zero-fills buffers extended to a longer size", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hi"));

        handles.truncateByIno(1n, 4, fh);

        expect(handles.get(fh)?.buffer).toEqual(
          new Uint8Array([0x68, 0x69, 0, 0]),
        );
      });

      it("leaves a buffer already at the size with its bytes and marks it dirty", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));

        handles.truncateByIno(1n, 5, fh);

        const handle = handles.get(fh);
        expect(decoder.decode(handle?.buffer)).toBe("hello");
        expect(handle?.dirty).toBe(true);
        expect(handle?.version).toBe(1);
      });

      it("marks only the pending handle dirty for a nonzero size", () => {
        const handles = new HandleMap();
        const truncating = handles.open(1n, O_RDWR, encoder.encode("hello"));
        const bystander = handles.open(1n, O_RDWR, encoder.encode("hello"));

        handles.truncateByIno(1n, 3, truncating);

        const truncatingHandle = handles.get(truncating);
        expect(decoder.decode(truncatingHandle?.buffer)).toBe("hel");
        expect(truncatingHandle?.dirty).toBe(true);
        expect(handleHasPendingChanges(truncatingHandle)).toBe(true);

        const bystanderHandle = handles.get(bystander);
        expect(decoder.decode(bystanderHandle?.buffer)).toBe("hel");
        expect(bystanderHandle?.dirty).toBe(false);
        expect(handleHasPendingChanges(bystanderHandle)).toBe(false);
        expect(handleHasBufferedContent(bystanderHandle)).toBe(true);
      });

      it("gives a handle holding no buffer an empty one at size zero, and leaves it reading the inode at another size", () => {
        const handles = new HandleMap();
        const writer = handles.open(1n, O_RDWR, encoder.encode("hello"));
        const reader = handles.open(1n, O_RDONLY, encoder.encode("hello"));

        handles.truncateByIno(1n, 2, writer);
        expect(handleHasBufferedContent(handles.get(reader))).toBe(false);

        handles.truncateByIno(1n, 0, writer);
        const readerHandle = handles.get(reader);
        expect(handleHasBufferedContent(readerHandle)).toBe(true);
        expect(readerHandle?.buffer.length).toBe(0);
        expect(handleHasPendingChanges(readerHandle)).toBe(false);
      });

      it("zero-fills a pending buffer a flush discarded, marking it dirty", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_WRONLY, encoder.encode("hello"));
        discardBuffer(handles.get(fh)!);

        handles.truncateByIno(1n, 2, fh);

        const handle = handles.get(fh);
        expect(handle?.buffer).toEqual(new Uint8Array(2));
        expect(handleHasPendingChanges(handle)).toBe(true);
      });
    });

    describe("truncate()", () => {
      it("throws for a read-only handle", () => {
        const handles = new HandleMap();
        const reader = handles.open(1n, O_RDONLY, encoder.encode("hello"));

        expect(() => handles.truncate(reader, 0)).toThrow(
          `File handle ${reader} is not open for writing`,
        );
        expect(handleHasPendingChanges(handles.get(reader))).toBe(false);
      });

      it("resizes a buffer a flush discarded from empty, as a pending change", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_WRONLY, encoder.encode("hello"));
        discardBuffer(handles.get(fh)!);

        handles.truncate(fh, 0);
        expect(handles.get(fh)?.truncatePending).toBe(true);

        discardBuffer(handles.get(fh)!);
        handles.truncate(fh, 3);
        const handle = handles.get(fh);
        expect(handle?.buffer).toEqual(new Uint8Array(3));
        expect(handle?.dirty).toBe(true);
      });

      it("throws for a closed handle", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));
        handles.close(fh);

        expect(() => handles.truncate(fh, 0)).toThrow(
          `No open file handle ${fh}`,
        );
        expect(handles.get(fh)).toBeUndefined();
      });

      it("empties the buffer as a pending truncate for size zero", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));
        handles.write(fh, encoder.encode("J"), 0);

        handles.truncate(fh, 0);

        const handle = handles.get(fh);
        expect(handle?.buffer.length).toBe(0);
        expect(handle?.dirty).toBe(false);
        expect(handle?.truncatePending).toBe(true);
        expect(handle?.version).toBe(2);
      });

      it("cuts the buffer to a shorter size as dirty content", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));
        handles.truncate(fh, 0);
        handles.write(fh, encoder.encode("hello"), 0);

        handles.truncate(fh, 2);

        const handle = handles.get(fh);
        expect(decoder.decode(handle?.buffer)).toBe("he");
        expect(handle?.dirty).toBe(true);
        expect(handle?.truncatePending).toBe(false);
      });

      it("zero-fills the buffer extended to a longer size as dirty content", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hi"));

        handles.truncate(fh, 4);

        const handle = handles.get(fh);
        expect(handle?.buffer).toEqual(new Uint8Array([0x68, 0x69, 0, 0]));
        expect(handle?.dirty).toBe(true);
      });

      it("leaves the buffers of other handles on the inode alone", () => {
        const handles = new HandleMap();
        const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));
        const sibling = handles.open(1n, O_RDWR, encoder.encode("hello"));

        handles.truncate(fh, 1);

        expect(decoder.decode(handles.get(sibling)?.buffer)).toBe("hello");
        expect(handles.get(sibling)?.dirty).toBe(false);
      });
    });
  });
});
