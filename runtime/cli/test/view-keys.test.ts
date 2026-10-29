import { assertEquals } from "@std/assert";
import { decodeKeys } from "../lib/view/keys.ts";
import { bytes, raw } from "./view-helpers.ts";

function names(input: Uint8Array): string[] {
  return decodeKeys(input).keys.map((k) => k.name);
}

Deno.test("decode: printable characters and space", () => {
  const { keys } = decodeKeys(bytes("a/?\\"));
  assertEquals(keys.map((k) => k.name), ["a", "/", "?", "\\"]);
  assertEquals(keys[0].char, "a");
  assertEquals(keys[3].char, "\\");
  assertEquals(names(bytes(" ")), ["space"]);
});

Deno.test("decode: enter, tab, backspace", () => {
  assertEquals(names(raw(0x0d)), ["enter"]);
  assertEquals(names(raw(0x0a)), ["enter"]);
  assertEquals(names(raw(0x09)), ["tab"]);
  assertEquals(names(raw(0x7f)), ["backspace"]);
  assertEquals(names(raw(0x08)), ["backspace"]);
});

Deno.test("decode: control combinations", () => {
  assertEquals(names(raw(0x03)), ["ctrl-c"]);
  assertEquals(names(raw(0x04)), ["ctrl-d"]);
  assertEquals(names(raw(0x06)), ["ctrl-f"]);
  assertEquals(names(raw(0x02)), ["ctrl-b"]);
});

Deno.test("decode: arrow keys (CSI)", () => {
  assertEquals(names(raw(0x1b, 0x5b, 0x41)), ["up"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x42)), ["down"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x43)), ["right"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x44)), ["left"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x48)), ["home"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x46)), ["end"]);
});

Deno.test("decode: SGR mouse wheel reports", () => {
  assertEquals(names(bytes("\x1b[<64;12;7M")), ["wheel-up"]);
  assertEquals(names(bytes("\x1b[<65;12;7M")), ["wheel-down"]);
  assertEquals(names(bytes("\x1b[<68;12;7M")), ["wheel-up"]);
  assertEquals(names(bytes("\x1b[<69;12;7M")), ["wheel-down"]);
  assertEquals(names(bytes("\x1b[<65;12;7m")), ["unknown"]);
});

Deno.test("decode: SGR primary-button presses and releases carry their cell", () => {
  assertEquals(decodeKeys(bytes("\x1b[<0;12;7M\x1b[<0;13;7m")).keys, [
    { name: "mouse", mouse: { down: true, x: 11, y: 6 } },
    { name: "mouse", mouse: { down: false, x: 12, y: 6 } },
  ]);
  // A shift-click is still a click.
  assertEquals(names(bytes("\x1b[<4;1;1M")), ["mouse"]);
  // The middle and right buttons are not the primary button, and a report of
  // the pointer moving is not a press.
  for (const report of ["<1;12;7M", "<1;12;7m", "<2;12;7M", "<2;12;7m"]) {
    assertEquals(names(bytes(`\x1b[${report}`)), ["unknown"], report);
  }
  assertEquals(names(bytes("\x1b[<32;12;7M")), ["unknown"]);
});

Deno.test("decode: an SGR mouse report missing a number is unknown", () => {
  for (const report of ["<M", "<0M", "<0;5M", "<;;M", "<0;5;M", "<0;5;7;1M"]) {
    assertEquals(names(bytes(`\x1b[${report}`)), ["unknown"], report);
  }
});

Deno.test("decode: X10 mouse wheel reports", () => {
  assertEquals(names(raw(0x1b, 0x5b, 0x4d, 96, 33, 33)), ["wheel-up"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x4d, 97, 33, 33)), ["wheel-down"]);
});

Deno.test("decode: X10 presses and releases carry their cell", () => {
  // Each byte is its value plus 32; the cell is one-based; a release is
  // button 3.
  assertEquals(
    decodeKeys(raw(0x1b, 0x5b, 0x4d, 32, 44, 39, 0x1b, 0x5b, 0x4d, 35, 33, 33))
      .keys,
    [
      { name: "mouse", mouse: { down: true, x: 11, y: 6 } },
      { name: "mouse", mouse: { down: false, x: 0, y: 0 } },
    ],
  );
  // The right button, and the pointer moving.
  assertEquals(names(raw(0x1b, 0x5b, 0x4d, 34, 33, 33)), ["unknown"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x4d, 64, 33, 33)), ["unknown"]);
});

Deno.test("decode: an incomplete X10 mouse report remains buffered", () => {
  const input = raw(0x1b, 0x5b, 0x4d, 96, 33);
  const result = decodeKeys(input);
  assertEquals(result.keys, []);
  assertEquals(result.rest, input);
});

Deno.test("decode: page up/down and home/end (tilde sequences)", () => {
  assertEquals(names(raw(0x1b, 0x5b, 0x35, 0x7e)), ["pageup"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x36, 0x7e)), ["pagedown"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x31, 0x7e)), ["home"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x34, 0x7e)), ["end"]);
});

Deno.test("decode: SS3 arrows (application mode)", () => {
  assertEquals(names(raw(0x1b, 0x4f, 0x41)), ["up"]);
  assertEquals(names(raw(0x1b, 0x4f, 0x44)), ["left"]);
});

Deno.test("decode: lone ESC is Escape", () => {
  assertEquals(names(raw(0x1b)), ["escape"]);
});

Deno.test("decode: a CSI split across reads parses via the leftover buffer", () => {
  const first = decodeKeys(raw(0x1b, 0x5b));
  assertEquals(first.keys.length, 0);
  assertEquals(first.rest, raw(0x1b, 0x5b));
  const second = decodeKeys(new Uint8Array([...first.rest, 0x41]));
  assertEquals(second.keys.map((k) => k.name), ["up"]);
  assertEquals(second.rest.length, 0);
});

Deno.test("decode: mixed batch in one read", () => {
  // 'j' then Down then Enter
  const input = new Uint8Array([0x6a, 0x1b, 0x5b, 0x42, 0x0d]);
  assertEquals(names(input), ["j", "down", "enter"]);
});

Deno.test("decode: multibyte UTF-8 character", () => {
  const { keys } = decodeKeys(bytes("λ"));
  assertEquals(keys.length, 1);
  assertEquals(keys[0].name, "λ");
  assertEquals(keys[0].char, "λ");
});

Deno.test("decode: a multibyte char split across reads keeps the partial in rest", () => {
  // "λ" is 0xCE 0xBB. Deliver only the lead byte: it must be held in `rest`,
  // not decoded into a U+FFFD replacement character.
  const utf8 = bytes("λ");
  const first = decodeKeys(utf8.subarray(0, 1));
  assertEquals(first.keys.length, 0);
  assertEquals(first.rest, raw(0xce));
  // The next read prepends the leftover and completes the code point.
  const second = decodeKeys(new Uint8Array([...first.rest, utf8[1]]));
  assertEquals(second.keys.map((k) => k.name), ["λ"]);
  assertEquals(second.keys[0].char, "λ");
  assertEquals(second.rest.length, 0);
});

Deno.test("decode: a 4-byte emoji split across reads completes cleanly", () => {
  // "😀" is 0xF0 0x9F 0x98 0x80. Split after the first two bytes.
  const utf8 = bytes("😀");
  const first = decodeKeys(utf8.subarray(0, 2));
  assertEquals(first.keys.length, 0);
  assertEquals(first.rest, utf8.subarray(0, 2));
  const second = decodeKeys(
    new Uint8Array([...first.rest, ...utf8.subarray(2)]),
  );
  assertEquals(second.keys.map((k) => k.name), ["😀"]);
  assertEquals(second.rest.length, 0);
});

Deno.test("decode: a stray continuation byte is not held in rest", () => {
  // 0x80 cannot start a sequence; it must decode now (to U+FFFD), not stall
  // forever waiting for bytes that complete it.
  const { keys, rest } = decodeKeys(raw(0x80));
  assertEquals(keys.length, 1);
  assertEquals(rest.length, 0);
  // An out-of-range lead byte (0xFF) behaves the same way.
  const bad = decodeKeys(raw(0xff));
  assertEquals(bad.keys.length, 1);
  assertEquals(bad.rest.length, 0);
});
