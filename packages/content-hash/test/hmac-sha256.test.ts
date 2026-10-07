import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { hmacSha256 } from "@commonfabric/content-hash";

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("hmacSha256()", () => {
  // RFC 4231, section 4: test cases 1, 2, 6 and 7. Cases 6 and 7 use a key
  // longer than one block, which is hashed before use.

  it("returns RFC 4231 test case 1", () => {
    expect(hmacSha256(bytes("0b".repeat(20)), text("Hi There"))).toEqual(
      bytes(
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
      ),
    );
  });

  it("returns RFC 4231 test case 2", () => {
    expect(
      hmacSha256(text("Jefe"), text("what do ya want for nothing?")),
    ).toEqual(
      bytes(
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
      ),
    );
  });

  it("returns RFC 4231 test case 6, whose key is longer than one block", () => {
    expect(
      hmacSha256(
        bytes("aa".repeat(131)),
        text("Test Using Larger Than Block-Size Key - Hash Key First"),
      ),
    ).toEqual(
      bytes(
        "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
      ),
    );
  });

  it("returns RFC 4231 test case 7", () => {
    expect(
      hmacSha256(
        bytes("aa".repeat(131)),
        text(
          "This is a test using a larger than block-size key and a larger " +
            "than block-size data. The key needs to be hashed before being " +
            "used by the HMAC algorithm.",
        ),
      ),
    ).toEqual(
      bytes(
        "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
      ),
    );
  });
});
