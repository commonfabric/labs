import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { decodeKeys } from "../../../lib/view/keys.ts";

/** The keys the terminal sent as `text`. */
function decoded(text: string) {
  return decodeKeys(new TextEncoder().encode(text)).keys;
}

describe("keys", () => {
  describe("decodeKeys()", () => {
    describe("with every key reported as the kitty keyboard protocol defines", () => {
      it("returns a key that typed text as that text", () => {
        expect(decoded("\x1b[97;;97u\x1b[97;2;65u\x1b[32;;32u")).toEqual([
          { name: "a", char: "a" },
          { name: "A", char: "A" },
          { name: "space", char: " " },
        ]);
      });

      it("returns a key reported without its text as the character of its code point, shifted when Shift is down and uppercase when Caps Lock is on", () => {
        expect(
          decoded(
            "\x1b[97u\x1b[97;2u\x1b[49:33;2u\x1b[97;65u\x1b[1089::99u" +
              "\x1b[1089:1057:99;2u",
          ),
        ).toEqual([
          { name: "a", char: "a" },
          { name: "A", char: "A" },
          { name: "!", char: "!" },
          { name: "A", char: "A" },
          { name: "с", char: "с" },
          { name: "С", char: "С" },
        ]);
      });

      it("returns only the printable characters of the text a key typed", () => {
        expect(decoded("\x1b[97;;27:97u")).toEqual([{ name: "a", char: "a" }]);
      });

      it("returns text that no key typed as that text, and an unknown key when there is none", () => {
        expect(decoded("\x1b[0;;229u\x1b[0u")).toEqual([
          { name: "å", char: "å" },
          { name: "unknown" },
        ]);
      });

      it("returns Alt with a letter as that letter with Alt, and with the character the key typed when the terminal reports one", () => {
        expect(decoded("\x1b[115;3u\x1b[115;3;223u\x1b[113:81;4u")).toEqual([
          { name: "s", alt: true },
          { name: "s", alt: true, char: "ß" },
          { name: "Q", alt: true, shift: true },
        ]);
      });

      it("returns Ctrl with a key as the key whose byte a terminal sends for it otherwise", () => {
        expect(
          decoded(
            "\x1b[99;5u\x1b[100;7u\x1b[104;5u\x1b[109;5u\x1b[106;5u" +
              "\x1b[105;5u\x1b[91;5u\x1b[32;5u",
          ),
        ).toEqual([
          { name: "ctrl-c", ctrl: true },
          { name: "ctrl-d", ctrl: true, alt: true },
          { name: "backspace" },
          { name: "enter" },
          { name: "enter" },
          { name: "tab" },
          { name: "escape" },
          { name: "ctrl-`", ctrl: true },
        ]);
      });

      it("returns Ctrl with Shift as Ctrl with the character the key types with Shift", () => {
        expect(decoded("\x1b[47:63;6u\x1b[99:67;6u\x1b[50:64;6u")).toEqual([
          { name: "backspace" },
          { name: "ctrl-c", ctrl: true },
          { name: "ctrl-`", ctrl: true },
        ]);
      });

      it("names a key that types an ASCII letter by that letter, wherever it is on the keyboard", () => {
        expect(
          decoded(
            "\x1b[99::105;5u\x1b[97::113;3u\x1b[97::113u\x1b[97:65:113;2u",
          ),
        ).toEqual([
          { name: "ctrl-c", ctrl: true },
          { name: "a", alt: true },
          { name: "a", char: "a" },
          { name: "A", char: "A" },
        ]);
      });

      it("names Ctrl and Alt with a letter outside ASCII by the letter in the same place on a US keyboard", () => {
        expect(
          decoded(
            "\x1b[1089::99;5u\x1b[1089::99;3;1089u\x1b[1089:1057:99;4u",
          ),
        ).toEqual([
          { name: "ctrl-c", ctrl: true },
          { name: "c", alt: true, char: "с" },
          { name: "C", alt: true, shift: true },
        ]);
      });

      it("returns Escape, Enter, Tab, Shift-Tab, and Backspace by name", () => {
        expect(
          decoded("\x1b[27u\x1b[13u\x1b[57414u\x1b[9u\x1b[9;2u\x1b[127;3u"),
        ).toEqual([
          { name: "escape" },
          { name: "enter" },
          { name: "enter" },
          { name: "tab" },
          { name: "shift-tab" },
          { name: "backspace", alt: true },
        ]);
      });

      it("returns a keypad key as the key on the main keyboard that types or moves the same way", () => {
        expect(
          decoded(
            "\x1b[57400;129;49u\x1b[57400;3u\x1b[57417u\x1b[57423;5u" +
              "\x1b[57426u",
          ),
        ).toEqual([
          { name: "1", char: "1" },
          { name: "1", alt: true },
          { name: "left" },
          { name: "home", ctrl: true },
          { name: "delete" },
        ]);
      });

      it("returns an unknown key for a key that types nothing and has no name here, and for a report with no key or a key that is no character", () => {
        expect(
          decoded("\x1b[57376u\x1b[;3u\x1b[?29u\x1b[1114112u\x1b[55296u"),
        ).toEqual([
          { name: "unknown" },
          { name: "unknown" },
          { name: "unknown" },
          { name: "unknown" },
          { name: "unknown" },
        ]);
      });

      it("returns nothing for a key with Command, a modifier pressed on its own, or Caps Lock", () => {
        expect(
          decoded("\x1b[115;9;115u\x1b[57441;2u\x1b[57358;65ux"),
        ).toEqual([{ name: "x", char: "x" }]);
      });

      it("returns Alt with Enter, Tab, Escape, and Backspace as the bytes ESC and the key's byte decode", () => {
        const reported = decoded("\x1b[13;3u\x1b[9;3u\x1b[127;3u\x1b[104;7u");
        const bytes = decoded("\x1b\r\x1b\t\x1b\x7f\x1b\x08");

        expect(reported).toEqual([
          { name: "enter", alt: true },
          { name: "tab", alt: true },
          { name: "backspace", alt: true },
          { name: "backspace", alt: true },
        ]);
        expect(bytes).toEqual(reported);
      });

      it("returns arrows and Home with the modifiers and lock state the terminal reports", () => {
        expect(decoded("\x1b[1;1A\x1b[1;67D\x1b[1;65H")).toEqual([
          { name: "up" },
          { name: "left", alt: true },
          { name: "home" },
        ]);
      });
    });
  });
});
