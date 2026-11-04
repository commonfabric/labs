import { assertEquals } from "@std/assert";
import { decodeKeys, type Key } from "../lib/view/keys.ts";
import { raw } from "./view-helpers.ts";

function only(input: Uint8Array): Key {
  const { keys } = decodeKeys(input);
  assertEquals(keys.length, 1);
  return keys[0];
}

function names(input: Uint8Array): string[] {
  return decodeKeys(input).keys.map((k) => k.name);
}

Deno.test("decode: SS3 truncated (ESC O) is buffered as leftover", () => {
  // SS3 split across reads: `ESC O` with the final byte not yet arrived breaks
  // out of the loop and leaves the whole sequence as leftover (line 50).
  const r = decodeKeys(raw(0x1b, 0x4f));
  assertEquals(r.keys.length, 0);
  assertEquals(Array.from(r.rest), [0x1b, 0x4f]);
  // Completing it on the next read yields the key.
  const r2 = decodeKeys(new Uint8Array([...r.rest, 0x41]));
  assertEquals(r2.keys.map((k) => k.name), ["up"]);
});

Deno.test("decode: ESC + control byte is ctrl+alt combo", () => {
  // ESC followed by a control byte (n < 0x20): Alt+Ctrl combo (lines 81-89).
  // ESC then 0x01 (ctrl-a): name ctrl-a, ctrl + alt.
  const k = only(raw(0x1b, 0x01));
  assertEquals(k.name, "ctrl-a");
  assertEquals(k.ctrl, true);
  assertEquals(k.alt, true);
  // ESC then 0x02 (ctrl-b).
  const k2 = only(raw(0x1b, 0x02));
  assertEquals(k2.name, "ctrl-b");
  assertEquals(k2.ctrl, true);
  assertEquals(k2.alt, true);
});

Deno.test("decode: ESC + printable byte is alt+letter", () => {
  // ESC + printable byte (n < 0x80) is Alt+letter (lines 90-94, sibling
  // branch).
  const k = only(raw(0x1b, 0x62)); // ESC 'b'
  assertEquals(k.name, "b");
  assertEquals(k.alt, true);
  assertEquals(k.char, undefined);
});

Deno.test("decode: ESC + backspace is alt-backspace", () => {
  // ESC + DEL / ESC + BS → alt-backspace (lines 76-79, sibling branch).
  const k = only(raw(0x1b, 0x7f));
  assertEquals(k.name, "backspace");
  assertEquals(k.alt, true);
  const k2 = only(raw(0x1b, 0x08));
  assertEquals(k2.name, "backspace");
  assertEquals(k2.alt, true);
});

Deno.test("decode: ESC + high byte emits Escape and keeps the high byte", () => {
  // ESC followed by a high byte (n >= 0x80) we do not model: emit Escape and
  // only consume the ESC, leaving the high byte to be decoded next (97-100).
  // ESC then 0xc3 0xa9 ('é' in UTF-8): ESC alone, then the char.
  const { keys } = decodeKeys(raw(0x1b, 0xc3, 0xa9));
  assertEquals(keys.length, 2);
  assertEquals(keys[0].name, "escape");
  assertEquals(keys[1].name, "é");
  assertEquals(keys[1].char, "é");
});

Deno.test("decode: ESC ESC emits Escape", () => {
  // ESC ESC → Escape, consuming a single ESC (lines 68-71, sibling branch).
  const { keys } = decodeKeys(raw(0x1b, 0x1b));
  assertEquals(keys[0].name, "escape");
});

//
// CSI modifier param: shift bit (line 147) and ctrl bit (line 149).
//

Deno.test("decode: CSI shift modifier on arrow", () => {
  // ESC [ 1 ; 2 A → shift+up. bits = 2-1 = 1 → shift.
  const k = only(raw(0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x41));
  assertEquals(k.name, "up");
  assertEquals(k.shift, true);
  assertEquals(k.alt, undefined);
  assertEquals(k.ctrl, undefined);
});

Deno.test("decode: CSI ctrl modifier on arrow", () => {
  // ESC [ 1 ; 5 A → ctrl+up. bits = 5-1 = 4 → ctrl.
  const k = only(raw(0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x41));
  assertEquals(k.name, "up");
  assertEquals(k.ctrl, true);
  assertEquals(k.shift, undefined);
  assertEquals(k.alt, undefined);
});

Deno.test("decode: CSI shift+alt+ctrl combined modifier", () => {
  // ESC [ 1 ; 8 A → bits = 8-1 = 7 → shift+alt+ctrl.
  const k = only(raw(0x1b, 0x5b, 0x31, 0x3b, 0x38, 0x41));
  assertEquals(k.name, "up");
  assertEquals(k.shift, true);
  assertEquals(k.alt, true);
  assertEquals(k.ctrl, true);
});

//
// CSI finals beyond the arrows (lines 168-181).
//

Deno.test("decode: CSI shift-tab (Z)", () => {
  assertEquals(only(raw(0x1b, 0x5b, 0x5a)).name, "shift-tab");
});

Deno.test("decode: CSI function keys P/Q/R/S map to f1-f4", () => {
  assertEquals(only(raw(0x1b, 0x5b, 0x50)).name, "f1");
  assertEquals(only(raw(0x1b, 0x5b, 0x51)).name, "f2");
  assertEquals(only(raw(0x1b, 0x5b, 0x52)).name, "f3");
  assertEquals(only(raw(0x1b, 0x5b, 0x53)).name, "f4");
});

Deno.test("decode: CSI unknown final is 'unknown'", () => {
  // ESC [ X (0x58) — not a modeled final.
  assertEquals(only(raw(0x1b, 0x5b, 0x58)).name, "unknown");
});

//
// Tilde sequences (lines 179, 195-226).
//

Deno.test("decode: tilde delete (3~)", () => {
  const k = only(raw(0x1b, 0x5b, 0x33, 0x7e));
  assertEquals(k.name, "delete");
});

Deno.test("decode: tilde delete with modifiers (3;5~ → ctrl+delete)", () => {
  const k = only(raw(0x1b, 0x5b, 0x33, 0x3b, 0x35, 0x7e));
  assertEquals(k.name, "delete");
  assertEquals(k.ctrl, true);
});

Deno.test("decode: tilde home/end variants (7~, 8~)", () => {
  assertEquals(only(raw(0x1b, 0x5b, 0x37, 0x7e)).name, "home");
  assertEquals(only(raw(0x1b, 0x5b, 0x38, 0x7e)).name, "end");
});

Deno.test("decode: tilde function keys f1-f12", () => {
  const csiTilde = (code: number): string => {
    const k = only(
      new Uint8Array([
        0x1b,
        0x5b,
        ...new TextEncoder().encode(String(code)),
        0x7e,
      ]),
    );
    return k.name;
  };
  assertEquals(csiTilde(11), "f1");
  assertEquals(csiTilde(12), "f2");
  assertEquals(csiTilde(13), "f3");
  assertEquals(csiTilde(14), "f4");
  assertEquals(csiTilde(15), "f5");
  assertEquals(csiTilde(17), "f6");
  assertEquals(csiTilde(18), "f7");
  assertEquals(csiTilde(19), "f8");
  assertEquals(csiTilde(20), "f9");
  assertEquals(csiTilde(21), "f10");
  assertEquals(csiTilde(23), "f11");
  assertEquals(csiTilde(24), "f12");
});

Deno.test("decode: tilde unknown code is 'unknown'", () => {
  // ESC [ 9 9 ~ — code 99 is not modeled.
  const k = only(raw(0x1b, 0x5b, 0x39, 0x39, 0x7e));
  assertEquals(k.name, "unknown");
});

//
// SS3 sequences (lines 234-253).
//

Deno.test("decode: SS3 down/right/left", () => {
  assertEquals(only(raw(0x1b, 0x4f, 0x42)).name, "down");
  assertEquals(only(raw(0x1b, 0x4f, 0x43)).name, "right");
  assertEquals(only(raw(0x1b, 0x4f, 0x44)).name, "left");
});

Deno.test("decode: SS3 home/end", () => {
  assertEquals(only(raw(0x1b, 0x4f, 0x48)).name, "home");
  assertEquals(only(raw(0x1b, 0x4f, 0x46)).name, "end");
});

Deno.test("decode: SS3 function keys P/Q/R/S map to f1-f4", () => {
  assertEquals(only(raw(0x1b, 0x4f, 0x50)).name, "f1");
  assertEquals(only(raw(0x1b, 0x4f, 0x51)).name, "f2");
  assertEquals(only(raw(0x1b, 0x4f, 0x52)).name, "f3");
  assertEquals(only(raw(0x1b, 0x4f, 0x53)).name, "f4");
});

Deno.test("decode: SS3 unknown final is 'unknown'", () => {
  // ESC O X (0x58) — not a modeled SS3 final.
  assertEquals(only(raw(0x1b, 0x4f, 0x58)).name, "unknown");
});

//
// A batch across branches
//

Deno.test("decode: mixed batch crosses SS3, CSI-mod and tilde branches", () => {
  // Sanity: a longer batch threading several of the above branches together.
  const input = new Uint8Array([
    0x1b,
    0x4f,
    0x42, // SS3 down
    0x1b,
    0x5b,
    0x31,
    0x3b,
    0x35,
    0x43, // ctrl+right
    0x1b,
    0x5b,
    0x33,
    0x7e, // delete
  ]);
  assertEquals(names(input), ["down", "right", "delete"]);
});
