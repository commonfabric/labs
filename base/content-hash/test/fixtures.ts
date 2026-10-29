/**
 * Test fixtures for hashing.
 *
 * **Note:** To add tests and have the hashes calculated for you, add entries
 * to `FIXTURES` with the hash as `xx` and then run the unit test. The console
 * output will give you the values.
 */

import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import { sha256 } from "@commonfabric/content-hash";

/** A fixture as authored: the payload as numbers, and its expected hash. */
interface NumbersHashTuple {
  numbers: readonly number[];
  sha256: string;
}

/** A fixture as used: a `NumbersHashTuple` with the payload also as bytes. */
export interface ContentHashTuple extends NumbersHashTuple {
  bytes: Uint8Array;
}

/** Text of the large fixture file, used as the multi-kilobyte payload. */
const BIG_TEXT_FILE = Deno.readTextFileSync(
  new URL("fixture-frank.txt", import.meta.url),
);

/** Returns an array of `count` copies of `value`. */
function repeatByte(count: number, value: number): number[] {
  return new Array(count).fill(value);
}

/**
 * Returns `count` byte values, generated deterministically from `seed` by an
 * arbitrary mixing function. The point is a payload with no repeating run
 * that a hasher could get right by accident.
 */
function rainbowBytes(count: number, seed: number): number[] {
  const result = new Array(count);
  let value = seed;

  for (let i = 0; i < count; i++) {
    result[i] = value & 0xff;
    value = (value * 543) ^ (value << 5) ^ (value >> 2);
    value = Math.floor(Math.abs(value) * 1.2345) & 0xffffff;
    if (value === 0) {
      seed++;
      value = seed;
    }
  }

  return result;
}

/** The fixtures, as authored. */
const NUMBERS_FIXTURES: readonly NumbersHashTuple[] = [
  {
    numbers: [],
    sha256: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
  },
  {
    numbers: repeatByte(1, 0),
    sha256: "bjQLnP-zepicpUTmu3gKLHiQHT-zNzh2hRGjBhevoB0",
  },
  {
    numbers: repeatByte(2, 0),
    sha256: "lqKW0iTyhcZ77pPDD4owkVfw2qNdxbh-QQt4YwoJz8c",
  },
  {
    numbers: repeatByte(3, 0),
    sha256: "cJ6AyISHokEeHuTfufIqhhSS0gxHZRUMDHlKvXD4FHw",
  },
  {
    numbers: repeatByte(4, 0),
    sha256: "3z9hmASpL9tAVxktxD3XSOp3itxSvEmM6AUkwBS4ERk",
  },
  {
    numbers: repeatByte(5, 0),
    sha256: "iFVQiq3hbsVz0h5qSF39CnYkCFwaFLXs3WSF3gxoOaQ",
  },
  {
    numbers: repeatByte(100, 0),
    sha256: "zQDiksWXDTxeLw_6UXHlVbxGv8T63ftKQYtoQLhueaM",
  },
  {
    numbers: repeatByte(1000, 0),
    sha256: "VBs-naoJsgv4X6Jz5cvT6AGFqk7CmOdl24d0K3ATilM",
  },
  {
    numbers: repeatByte(10000, 0),
    sha256: "lbUyzEOBr_3_DZVuElIKBBKe1J034VQig2j-ViHwuaI",
  },
  {
    numbers: repeatByte(100000, 0),
    sha256: "kZLCW3NPy62-MtrcKAicYNsOOfkMwgzi5XM_VyYazAw",
  },
  {
    numbers: repeatByte(1, 200),
    sha256: "fFvS0UT93kmEBu3Ln-YM5lsN-l8t16dhf1BePUbWi9s",
  },
  {
    numbers: repeatByte(2, 210),
    sha256: "9fUHJuJIDMoPngMaesN1E5wwECzvLQfY77ol1U7c-Rg",
  },
  {
    numbers: repeatByte(3, 220),
    sha256: "czkz__2Q2ArL8-AblAUh_TlmMaUw0UvKpMJPUnaD_I0",
  },
  {
    numbers: repeatByte(4, 240),
    sha256: "cjXm14AjgRFUyLr8n_m_ppTAhRaLoMU8UGEvHJsXsRs",
  },
  {
    numbers: repeatByte(5, 255),
    sha256: "EyNpo7fyT6YZeFxOLu5ohV9dRsvgqqGerdDbwt1ZLDk",
  },
  {
    numbers: repeatByte(100, 120),
    sha256: "Cey268i878cz9vLsRPeRq-7WqZ7fDMMVGWN4mK69Utg",
  },
  {
    numbers: repeatByte(1000, 121),
    sha256: "fjOuPx6I3fMpEQnMNmsS3Ni_j-d77FMAnyAKduRknAc",
  },
  {
    numbers: repeatByte(10000, 122),
    sha256: "C3Iripa_6Eo70W2dQc0qGkM15rl01uoEEr3v9EYuR58",
  },
  {
    numbers: repeatByte(100000, 123),
    sha256: "n6_r803mJ88PloqDmCorxjQ0a2eTfD9TWfMxp0wvS8g",
  },
  {
    numbers: rainbowBytes(5, 5),
    sha256: "4B_erEROmBo1GFfHyuqloBR4BKBwUFdyq33q_uEF-a8",
  },
  {
    numbers: rainbowBytes(6, 50),
    sha256: "Xr5j1g0TkW_GOHfWUxKc9k9bYq2Wmz3L_7O7Ur1uo3I",
  },
  {
    numbers: rainbowBytes(7, 500),
    sha256: "9oBnZb_jeFcii9RKTYFG3gTRhCSX8aPA-8qyF7rceQg",
  },
  {
    numbers: rainbowBytes(8, 5000),
    sha256: "iLYHtjky0lafAjqBt_vFsaSdF2jE52zIVjKN-_EAwKI",
  },
  {
    numbers: rainbowBytes(9, 50000),
    sha256: "wai-7t_ww2G03mSxSy9m8eK0e18UBj5eU5NAMk6JQrc",
  },
  {
    numbers: rainbowBytes(100, 1),
    sha256: "E6BbH-dzBowLZ0WWjdeKcfbx_2DngSYOccwgfKo6fHE",
  },
  {
    numbers: rainbowBytes(235, 7),
    sha256: "5w7_tbfxM-lGLQEgrLvBZ22cAjykQKhIlzGzciRAbeU",
  },
  {
    numbers: rainbowBytes(99999, 765),
    sha256: "AXSZe6EIEni2GvoEsj9mTur4SN2chadIcdrqVf8yqEo",
  },
  {
    numbers: rainbowBytes(501921, 998877),
    sha256: "vA6wQSFCPVfwTczyM2Xl6nSXI6YD2vv6LBdcuGmrWn0",
  },
  {
    numbers: rainbowBytes(1234567, 98765),
    sha256: "s1iqGNj7KWV6YPVYEsTERmXlVFNEFWDuErFPez1asoI",
  },
  {
    numbers: [...BIG_TEXT_FILE].map((c) => c.charCodeAt(0)),
    sha256: "YXDqseQm9n0pXjTFlvopfttK2yLpUQQDs1llL7rst1A",
  },
] as const;

/** Whether any fixture was authored with its hash left as `xx`. */
let anyMissingHashes = false;

/** The fixtures, with the bytes form of each payload filled in. */
export const FIXTURES: readonly ContentHashTuple[] = Object.freeze(
  NUMBERS_FIXTURES.map(
    (one: NumbersHashTuple): ContentHashTuple => {
      const bytes = new Uint8Array(one.numbers);
      if (one.sha256 === "xx") {
        // Produce a missing hash.
        const hashStr = toUnpaddedBase64url(sha256(bytes));
        console.log("    sha256: %o,", hashStr);
        anyMissingHashes = true;
      }
      return { bytes, ...one };
    },
  ),
);

if (anyMissingHashes) {
  throw new Error("See console output for missing hashes.");
}
