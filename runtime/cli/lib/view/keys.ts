/**
 * Decodes raw terminal bytes into normalized {@link Key} events.
 *
 * Pure and incremental: {@link decodeKeys} returns the keys it could fully
 * parse plus any trailing bytes that form an incomplete escape sequence, which
 * the caller prepends to the next read. A lone ESC at the end of a read is
 * emitted as Escape immediately (local terminals deliver `ESC [ A` arrows in a
 * single read, so a solitary ESC means the Escape key) — this keeps Escape
 * responsive at the cost of mis-handling escape sequences split across reads,
 * which does not happen for local TTY input.
 */

export interface Key {
  /**
   * Normalized name: an arrow/nav name ("up", "down", "left", "right",
   * "pageup", "pagedown", "home", "end"), a mouse-wheel name ("wheel-up",
   * "wheel-down"), a press or release of the primary mouse button ("mouse"),
   * the pointer moving with that button held ("drag"), text pasted while
   * bracketed paste is on ("paste", the text in `text`), a function key
   * ("f1".."f12"), an editing name ("enter",
   * "escape", "backspace", "delete", "tab", "space"), a control combo
   * ("ctrl-c", "ctrl-d", …), or the literal character for a printable key
   * ("a", "/", "?").
   */
  readonly name: string;

  readonly ctrl?: boolean;

  /** Alt/Meta modifier (from `ESC <key>` or a CSI modifier param). For an
   * Alt+letter, `name` is the letter, and `char` is the character the key
   * typed when the terminal reports one, such as the `ß` that Option+S types
   * on a Mac. */
  readonly alt?: boolean;

  readonly shift?: boolean;

  /** The printable character, when the key produced one. */
  readonly char?: string;

  /** The primary mouse button going down or coming up, for a "mouse" key. */
  readonly mouse?: MouseButton;

  /** Where the pointer was, for a "drag" or wheel key. */
  readonly at?: { readonly x: number; readonly y: number };

  /** The text pasted, for a "paste" key, as it arrived. */
  readonly text?: string;
}

/** A press or release of the primary mouse button. */
export interface MouseButton {
  /** Whether the button went down, rather than coming up. */
  readonly down: boolean;

  /** Zero-based screen column of the cell under the pointer. */
  readonly x: number;

  /** Zero-based screen row of the cell under the pointer. */
  readonly y: number;
}

export interface DecodeResult {
  readonly keys: Key[];
  readonly rest: Uint8Array;
}

export function decodeKeys(buf: Uint8Array): DecodeResult {
  const keys: Key[] = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];

    if (b === 0x1b) {
      if (i + 1 >= buf.length) {
        keys.push({ name: "escape" });
        i += 1;
        continue;
      }
      const n = buf[i + 1];
      if (n === 0x4f) { // SS3: ESC O <final>
        if (i + 2 >= buf.length) break;
        keys.push(ss3ToKey(buf[i + 2]));
        i += 3;
        continue;
      }
      if (n === 0x5b) { // CSI: ESC [ <params> <final>
        // X10 mouse reports put the three encoded mouse bytes after the `M`
        // final instead of inside the CSI parameters.
        if (i + 2 < buf.length && buf[i + 2] === 0x4d) {
          if (i + 5 >= buf.length) break;
          // Each byte is its value plus 32, and the cell is one-based.
          keys.push(
            mouseToKey(buf[i + 3] - 32, buf[i + 4] - 33, buf[i + 5] - 33),
          );
          i += 6;
          continue;
        }
        let j = i + 2;
        let params = "";
        while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x3f) {
          params += String.fromCharCode(buf[j]);
          j += 1;
        }
        if (j >= buf.length) break; // final byte not arrived yet
        if (params === "200" && buf[j] === 0x7e) {
          // A bracketed paste runs to `ESC [ 201 ~`, and waits for it.
          const end = indexOf(buf, PASTE_END, j + 1);
          if (end < 0) break;
          const text = new TextDecoder().decode(buf.slice(j + 1, end));
          keys.push({ name: "paste", text });
          i = end + PASTE_END.length;
          continue;
        }
        const key = buf[j] === 0x75
          ? reportedKey(params)
          : csiToKey(buf[j], params);
        if (key) keys.push(key);
        i = j + 1;
        continue;
      }
      // ESC ESC: a real Escape (or a doubled meta prefix); emit Escape.
      if (n === 0x1b) {
        keys.push({ name: "escape" });
        i += 1;
        continue;
      }
      // Meta/Alt: `ESC <key>` is Alt+key. A control byte or Delete → its key
      // with `alt`, so Backspace is alt-backspace (backward-kill-word); a
      // printable byte → the letter with `alt`.
      if (n < 0x20 || n === 0x7f) {
        keys.push({ ...byteKey(n), alt: true });
        i += 2;
        continue;
      }
      if (n < 0x80) {
        const ch = String.fromCharCode(n);
        keys.push({ name: ch, alt: true });
        i += 2;
        continue;
      }
      // ESC followed by a high byte we do not model: treat the ESC as Escape.
      keys.push({ name: "escape" });
      i += 1;
      continue;
    }

    if (b < 0x80) {
      keys.push(byteKey(b));
      i += 1;
    } else {
      // Multi-byte UTF-8: the lead byte's high bits give the sequence length.
      // 11110xxx (0xf0–0xf7) → 4, 1110xxxx (0xe0–0xef) → 3, 110xxxxx
      // (0xc0–0xdf) → 2. A stray continuation byte (10xxxxxx) or a byte that
      // can never start a sequence (0xf8–0xff) has no expected length: it is
      // decoded now as a replacement character rather than held back, so an
      // invalid byte cannot stall forever in `rest`.
      const expected = b >= 0xf8
        ? 1
        : b >= 0xf0
        ? 4
        : b >= 0xe0
        ? 3
        : b >= 0xc0
        ? 2
        : 1;
      let j = i + 1;
      while (
        j < buf.length && j - i < expected && (buf[j] & 0xc0) === 0x80
      ) j += 1;
      // A valid lead byte whose continuation bytes have not all arrived is an
      // incomplete code point at the end of the read; keep it in `rest` so the
      // next chunk completes it instead of emitting a replacement character.
      if (expected > 1 && j - i < expected && j === buf.length) break;
      const ch = new TextDecoder().decode(buf.slice(i, j));
      keys.push({ name: ch, char: ch });
      i = j;
    }
  }
  return { keys, rest: buf.slice(i) };
}

/** What ends a bracketed paste: `ESC [ 201 ~`. */
const PASTE_END = new TextEncoder().encode("\x1b[201~");

/** Where `needle` first occurs in `haystack` at or after `from`, or -1. */
function indexOf(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
  outer: for (let at = from; at + needle.length <= haystack.length; at++) {
    for (let k = 0; k < needle.length; k++) {
      if (haystack[at + k] !== needle[k]) continue outer;
    }
    return at;
  }
  return -1;
}

/** The modifier bits of the modifier field of a CSI sequence, `m` or
 * `m:event`, where m-1 is a bitmask of shift(1)/alt(2)/ctrl(4) and other
 * keys. */
function modifierBits(field: string | undefined): number {
  return (parseInt(field ?? "", 10) || 1) - 1;
}

interface Modifiers {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/** The modifiers among the modifier bits `bits` that the viewer binds. */
function modifiers(bits: number): Modifiers {
  const out: Modifiers = {};
  if (bits & 1) out.shift = true;
  if (bits & 2) out.alt = true;
  if (bits & 4) out.ctrl = true;
  return out;
}

function csiToKey(final: number, params: string): Key {
  const mods = modifiers(modifierBits(params.split(";")[1]));
  switch (final) {
    case 0x41:
      return { name: "up", ...mods };
    case 0x42:
      return { name: "down", ...mods };
    case 0x43:
      return { name: "right", ...mods };
    case 0x44:
      return { name: "left", ...mods };
    case 0x48:
      return { name: "home", ...mods };
    case 0x46:
      return { name: "end", ...mods };
    case 0x5a: // ESC [ Z
      return { name: "shift-tab" };
    case 0x50: // ESC [ P  (some terminals)
      return { name: "f1" };
    case 0x51:
      return { name: "f2" };
    case 0x52:
      return { name: "f3" };
    case 0x53:
      return { name: "f4" };
    case 0x4d: // ESC [ < button ; column ; row M — an SGR mouse press
    case 0x6d: // … m — an SGR mouse release
      return params.startsWith("<")
        ? sgrMouseToKey(params.slice(1), final === 0x6d)
        : { name: "unknown" };
    case 0x7e:
      return tildeKey(params, mods);
    default:
      return { name: "unknown" };
  }
}

/** The kitty keyboard protocol's modifier bits for Super, Hyper, and Meta,
 * which on a Mac include Command. */
const COMMAND_BITS = 8 | 16 | 32;

/** The kitty keyboard protocol's modifier bit for Caps Lock. */
const CAPS_LOCK_BIT = 64;

/** The code points the kitty keyboard protocol gives keys that type no
 * character of their own, such as Caps Lock and the keypad's keys. */
const FUNCTIONAL_KEYS = { from: 0xe000, to: 0xf8ff };

/** The characters of the keypad's keys that type, from KP_0, in the kitty
 * keyboard protocol's order. */
const KEYPAD_TEXT = { from: 57399, text: "0123456789./*-+\r=," };

/** The keys the keypad's keys that move stand for, from KP_LEFT, in the kitty
 * keyboard protocol's order. */
const KEYPAD_MOVES = {
  from: 57417,
  names: [
    "left",
    "right",
    "up",
    "down",
    "pageup",
    "pagedown",
    "home",
    "end",
    "unknown", // Insert, which `CSI 2 ~` also decodes as
    "delete",
  ],
};

/** Whether `code` is Caps Lock, Scroll Lock, Num Lock, or a modifier, which
 * the kitty keyboard protocol reports pressed on its own. */
function isModifier(code: number): boolean {
  return (code >= 57358 && code <= 57360) || (code >= 57441 && code <= 57454);
}

/**
 * Decodes the parameters of `CSI key:shifted:base ; modifiers ; text u`, a
 * key as the kitty keyboard protocol reports it: its code point, the code
 * points of the key with Shift and of the key in the same place on a US
 * keyboard, the modifier bits plus one, and the code points of the text it
 * typed. Each part but the first may be left out. Escape, Enter, Tab,
 * Backspace, and Ctrl with Space, `?`, or a character from `@` to `~` decode as
 * the byte a terminal otherwise sends for them does. Returns null for a key
 * pressed with Command, Super, Hyper, or
 * Meta, none of which the viewer binds, and for a modifier pressed on its
 * own.
 */
function reportedKey(params: string): Key | null {
  const [keyField, modField, textField = ""] = params.split(";");
  const [key, shifted, base] = keyField.split(":").map(codePoint);
  const bits = modifierBits(modField);
  const text = textField.split(":").map(codePoint).flatMap((point) =>
    point !== undefined && point >= 0x20 && point !== 0x7f
      ? [String.fromCodePoint(point)]
      : []
  ).join("");
  // Key 0 is text that no key typed.
  if (key === 0 && text) return typedKey(text);
  if (key === undefined || key === 0) return { name: "unknown" };
  if (bits & COMMAND_BITS || isModifier(key)) return null;
  const mods = modifiers(bits);
  const move = KEYPAD_MOVES.names[key - KEYPAD_MOVES.from];
  if (move) return { name: move, ...mods };
  const keypad = KEYPAD_TEXT.text[key - KEYPAD_TEXT.from];
  // With Alt or Ctrl, a key that types a letter outside ASCII is named by the
  // letter in its place on a US keyboard, as a terminal without the protocol
  // names it.
  const byBase = (mods.alt || mods.ctrl) && base !== undefined && key >= 0x80;
  const c = keypad?.charCodeAt(0) ?? (byBase ? base : key);
  if (c >= FUNCTIONAL_KEYS.from && c <= FUNCTIONAL_KEYS.to) {
    return { name: "unknown" };
  }
  if (c === 0x09 && mods.shift) return { name: "shift-tab" };
  // Ctrl turns the character the key types, with Shift if it is down, into
  // a control byte as a terminal does: `?` into Delete, and Space and `@` to
  // `~` into the byte of their low five bits.
  const typed = mods.shift && !byBase && shifted !== undefined ? shifted : c;
  const byte = c < 0x20 || c === 0x7f
    ? c
    : !mods.ctrl
    ? -1
    : typed === 0x3f
    ? 0x7f
    : typed === 0x20 || (typed >= 0x40 && typed < 0x7f)
    ? typed & 0x1f
    : -1;
  if (byte >= 0) {
    return mods.alt ? { ...byteKey(byte), alt: true } : byteKey(byte);
  }
  const letter = String.fromCodePoint(c);
  const name = !mods.shift
    ? letter
    : !byBase && shifted !== undefined
    ? String.fromCodePoint(shifted)
    : letter.toUpperCase();
  if (mods.alt || mods.ctrl) {
    return { name, ...mods, ...(text ? { char: text } : {}) };
  }
  return typedKey(
    text || (!mods.shift && bits & CAPS_LOCK_BIT ? letter.toUpperCase() : name),
  );
}

/** The key a terminal sends as the byte `b`, below 0x80, on its own. */
function byteKey(b: number): Key {
  if (b === 0x1b) return { name: "escape" };
  if (b === 0x0d || b === 0x0a) return { name: "enter" };
  if (b === 0x09) return { name: "tab" };
  if (b === 0x7f || b === 0x08) return { name: "backspace" };
  if (b < 0x20) {
    return { name: `ctrl-${String.fromCharCode(b + 96)}`, ctrl: true };
  }
  return typedKey(String.fromCharCode(b));
}

/** The key that typed `text`. */
function typedKey(text: string): Key {
  return text === " "
    ? { name: "space", char: " " }
    : { name: text, char: text };
}

/** The code point `field` gives as a decimal number, or undefined when it
 * gives none. */
function codePoint(field: string): number | undefined {
  const point = Number(field);
  return field !== "" && Number.isInteger(point) && point >= 0 &&
      point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
    ? point
    : undefined;
}

function tildeKey(params: string, mods: Modifiers): Key {
  const code = parseInt(params.split(";")[0] || "0", 10);
  switch (code) {
    case 1:
    case 7:
      return { name: "home", ...mods };
    case 4:
    case 8:
      return { name: "end", ...mods };
    case 3:
      return { name: "delete", ...mods };
    case 5:
      return { name: "pageup", ...mods };
    case 6:
      return { name: "pagedown", ...mods };
    case 11:
      return { name: "f1" };
    case 12:
      return { name: "f2" };
    case 13:
      return { name: "f3" };
    case 14:
      return { name: "f4" };
    case 15:
      return { name: "f5" };
    case 17:
      return { name: "f6" };
    case 18:
      return { name: "f7" };
    case 19:
      return { name: "f8" };
    case 20:
      return { name: "f9" };
    case 21:
      return { name: "f10" };
    case 23:
      return { name: "f11" };
    case 24:
      return { name: "f12" };
    default:
      return { name: "unknown" };
  }
}

/**
 * Decodes the `button;column;row` parameters of an SGR mouse report, whose cell
 * is one-based. A report that lacks one of the three numbers is unknown.
 */
function sgrMouseToKey(params: string, release: boolean): Key {
  const fields = /^(\d+);(\d+);(\d+)$/.exec(params);
  if (!fields) return { name: "unknown" };
  const [button, column, row] = fields.slice(1).map(Number);
  return mouseToKey(button, column - 1, row - 1, release);
}

/**
 * Maps a terminal mouse report at the zero-based cell `x`, `y` to the wheel
 * step it represents, the press or release of the primary button, or the
 * pointer moving with that button held. An SGR report says whether it is a
 * release; an X10 report gives every release as button 3, whichever button
 * was let go. A report of the pointer moving, which sets the 32 bit, is a
 * drag when the primary button is held and unknown otherwise.
 */
function mouseToKey(
  button: number,
  x: number,
  y: number,
  release = false,
): Key {
  const baseButton = button & ~(4 | 8 | 16); // the shift, alt, and ctrl bits
  if (baseButton === 0) {
    return { name: "mouse", mouse: { down: !release, x, y } };
  }
  if (release) return { name: "unknown" };
  if (baseButton === 3) return { name: "mouse", mouse: { down: false, x, y } };
  if (baseButton === 32) return { name: "drag", at: { x, y } };
  if (baseButton === 64) return { name: "wheel-up", at: { x, y } };
  if (baseButton === 65) return { name: "wheel-down", at: { x, y } };
  return { name: "unknown" };
}

function ss3ToKey(final: number): Key {
  switch (final) {
    case 0x41:
      return { name: "up" };
    case 0x42:
      return { name: "down" };
    case 0x43:
      return { name: "right" };
    case 0x44:
      return { name: "left" };
    case 0x48:
      return { name: "home" };
    case 0x46:
      return { name: "end" };
    case 0x50: // ESC O P
      return { name: "f1" };
    case 0x51:
      return { name: "f2" };
    case 0x52: // ESC O R — F3 (xterm/macOS Terminal)
      return { name: "f3" };
    case 0x53:
      return { name: "f4" };
    default:
      return { name: "unknown" };
  }
}
