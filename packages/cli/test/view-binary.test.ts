import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { _internal as viewInternals, buildView } from "../lib/view/mod.ts";
import { binaryLanguage } from "../lib/view/languages/binary/language.ts";
import {
  binaryLinesFrom,
  binaryPreviewExtent,
  MAX_BINARY_VIEW_BYTES,
  renderBinaryLines,
} from "../lib/view/languages/binary/binary.ts";
import {
  rawBytesDecoder,
  Utf8BinaryProbe,
  utf8Decoder,
} from "../lib/view/languages/decoder.ts";
import {
  canRenderDiffLines,
  renderedLinesFor,
} from "../lib/view/languages/language.ts";
import { markdownLanguage } from "../lib/view/languages/markdown/language.ts";
import { Session } from "../lib/view/session.ts";

describe("view-binary", () => {
  it("round-trips UTF-8 text and raw bytes through their decoders", () => {
    const text = "const greeting = 'héllo';\n";
    expect(utf8Decoder.decode(utf8Decoder.encode(text)).text).toBe(text);
    expect(() => utf8Decoder.decode(new Uint8Array([0xff, 0xfe])))
      .toThrow(TypeError);

    const bytes = new Uint8Array([0x00, 0x41, 0x80, 0xff]);
    const decodedRaw = rawBytesDecoder.decode(bytes);
    const raw = decodedRaw.text;
    expect(decodedRaw.hasUtf8Bom).toBe(false);
    expect([...raw].map((value) => value.charCodeAt(0))).toEqual([...bytes]);
    expect(rawBytesDecoder.encode(raw)).toEqual(bytes);
    expect(() => rawBytesDecoder.encode("λ")).toThrow(TypeError);

    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    const decodedBom = utf8Decoder.decode(bom);
    expect(decodedBom.text).toBe("A");
    expect(decodedBom.hasUtf8Bom).toBe(true);
    expect(decodedBom.encode(decodedBom.text)).toEqual(bom);
  });

  it("keeps binary detection decided and rejects truncated UTF-8 at EOF", () => {
    const nul = new Utf8BinaryProbe();
    expect(nul.write(new Uint8Array([0]))).toBe(true);
    expect(nul.write(new TextEncoder().encode("later text"))).toBe(true);
    expect(nul.finish()).toBe(true);

    const truncated = new Utf8BinaryProbe();
    expect(truncated.write(new Uint8Array([0xe2]))).toBe(false);
    expect(truncated.finish()).toBe(true);
  });

  it("renders canonical hex rows with control pictures", () => {
    const bytes = new Uint8Array([
      0x00,
      0x09,
      0x0a,
      0x0d,
      0x1b,
      0x1f,
      0x20,
      0x41,
      0x7e,
      0x7f,
      0x80,
      0x9f,
      0xa0,
      0xff,
      0x31,
      0x32,
    ]);

    expect(
      renderBinaryLines(rawBytesDecoder.decode(bytes).text).map((line) =>
        line.text
      ),
    ).toEqual([
      "00000000  00 09 0a 0d 1b 1f 20 41  7e 7f 80 9f a0 ff 31 32  |␀␉␊␍␛␟ A~␡␦␦␦␦12|",
      "00000010",
    ]);
  });

  it("returns a valid independent rendered layout", () => {
    const raw = rawBytesDecoder.decode(new Uint8Array([0x00, 0x0a, 0xff])).text;
    const rendered = renderedLinesFor(binaryLanguage, raw, "payload.data");

    expect(rendered?.length).toBe(2);
    assert(rendered?.[0].text.includes("00 0a ff"));
    expect(rendered?.at(-1)?.text).toBe("00000003");
    expect(canRenderDiffLines(binaryLanguage)).toBe(false);
    expect(canRenderDiffLines(markdownLanguage)).toBe(true);
  });

  it("keeps bytes read-only and renders them by default", () => {
    const bytes = new Uint8Array([0x61, 0x00, 0x62]);
    const view = buildView(bytes, "payload.data");
    const rendered = view.editSource.render?.(view.doc);

    expect(view.editSource.editable).toBe(false);
    expect(view.editSource.defaultViewMode).toBe("rendered");
    expect(view.doc.text.charCodeAt(1)).toBe(0);
    expect(view.doc.lines).toEqual([]);
    assert(rendered?.lines[0].text.endsWith("|a␀b|"));
    expect(rendered?.lines.at(-1)?.text).toBe("00000003");
  });

  it("starts interactive binary sessions in the rendered view", () => {
    const view = buildView(new Uint8Array([0x41, 0x00, 0xff]), "payload.data");
    const session = new Session(
      view.doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 20 },
      undefined,
      view.editSource,
    );

    assert(session.doc.lines[0].text.endsWith("|A␀␦|"));
    expect(session.doc.lines.at(-1)?.text).toBe("00000003");
  });

  it("streams rows across input chunk boundaries", async () => {
    const bytes = Uint8Array.from({ length: 35 }, (_, index) => index);
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield bytes.subarray(0, 5);
      yield bytes.subarray(5, 19);
      yield bytes.subarray(19);
    }

    const streamed = [];
    for await (const line of binaryLinesFrom(chunks())) {
      streamed.push(line.text);
    }
    expect(streamed).toEqual(
      renderBinaryLines(rawBytesDecoder.decode(bytes).text).map((line) =>
        line.text
      ),
    );
  });

  it("bounds rendered previews and reports omitted bytes", () => {
    const raw = "A".repeat(MAX_BINARY_VIEW_BYTES + 16);
    const lines = renderBinaryLines(raw);

    expect(lines.length).toBe(MAX_BINARY_VIEW_BYTES / 16 + 2);
    assert(lines.at(-2)?.text.includes("16 bytes omitted"));
    assert(lines.at(-2)?.text.includes("use --plain"));
    expect(lines.at(-1)?.text).toBe("00040010");
  });

  it("marks an incomplete preview without inventing a size", () => {
    const lines = renderBinaryLines("ABC", {
      byteLength: 3,
      complete: false,
    });

    expect(lines.length).toBe(2);
    assert(lines[0].text.endsWith("|ABC|"));
    expect(lines[1].text).toBe(
      "00000003  … preview stopped; total byte count unavailable …",
    );
  });

  it("returns incomplete preview extents for stale refreshed sizes", () => {
    expect(binaryPreviewExtent(256, 300, false, 299)).toEqual({
      byteLength: 256,
      complete: false,
    });
    expect(binaryPreviewExtent(256, 300, false, 320)).toEqual({
      byteLength: 320,
      complete: true,
    });
    expect(binaryPreviewExtent(256, 300, true, 299)).toEqual({
      byteLength: 300,
      complete: true,
    });
  });

  it("rejects strings that cannot represent raw bytes", () => {
    expect(() => renderBinaryLines("Aλ"))
      .toThrow("non-byte code unit at offset 1");
  });

  it("keeps independent layouts in the rendered view", () => {
    const view = buildView(new Uint8Array(512).fill(0), "payload.data");
    const session = new Session(
      view.doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 5 },
      undefined,
      view.editSource,
    );
    session.top = 10;
    expect(session.view().canRender).toBe(false);

    session.handleKey({ name: "v", char: "v" });

    expect(session.view().viewMode).toBe("rendered");
    expect(session.top).toBe(10);
    expect(session.view().message).toBe(
      "This rendered view has no line-aligned source view.",
    );
  });

  it("keeps transformed headers from overriding binary detection", () => {
    const header = new TextEncoder().encode("// transformed: module.ts\n");
    const bytes = new Uint8Array(header.length + 2);
    bytes.set(header);
    bytes.set([0x00, 0xff], header.length);

    const view = buildView(bytes);

    expect(view.editSource.defaultViewMode).toBe("rendered");
    expect(view.editSource.editable).toBe(false);
    assert(
      view.editSource.render?.(view.doc).lines[0].text.startsWith("00000000"),
    );
  });

  it("strips a UTF-8 BOM for parsers and restores it on save", () => {
    const dir = Deno.makeTempDirSync();
    try {
      const path = `${dir}/value.json`;
      const bytes = new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode(
          '{"value": 1}\n',
        ),
      ]);
      Deno.writeFileSync(path, bytes);

      const view = buildView(bytes, path);
      expect(view.doc.text).toBe('{"value": 1}\n');
      assert(
        view.doc.structure.length > 0,
        "JSON structure sees the first token",
      );
      expect(view.editSource.save('{"value": 2}\n', [])).toBe("Saved 1 file");
      expect(
        Deno.readFileSync(path),
      ).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode(
            '{"value": 2}\n',
          ),
        ]),
      );

      const markdown = buildView(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("# Heading\n"),
        ]),
        `${dir}/notes.md`,
      );
      expect(markdown.doc.text).toBe("# Heading\n");
      assert(markdown.doc.structure.length > 0, "Markdown sees the heading");
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  });

  it("completes short writes to redirected output", () => {
    const written: number[] = [];
    viewInternals.writeAllSync({
      writeSync(data: Uint8Array): number {
        const count = Math.min(2, data.length);
        for (const byte of data.subarray(0, count)) written.push(byte);
        return count;
      },
    }, new Uint8Array([1, 2, 3, 4, 5]));

    expect(written).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects a redirected writer that makes no progress", () => {
    expect(() =>
      viewInternals.writeAllSync(
        { writeSync: () => 0 },
        new Uint8Array([1]),
      )
    ).toThrow("stdout accepted no bytes");
  });
});
