import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  isPublicAddress,
  normalizeHostname,
  parseIpAddress,
} from "../src/network-address.ts";

const parsed = (text: string): Uint8Array => {
  const address = parseIpAddress(text);
  if (address === undefined) {
    throw new Error(`${text} did not parse`);
  }
  return address;
};

describe("network-address", () => {
  describe("normalizeHostname()", () => {
    it("returns the name in lowercase without brackets or a trailing dot", () => {
      expect(normalizeHostname("App.Example.")).toBe("app.example");
      expect(normalizeHostname("[::1]")).toBe("::1");
    });
  });

  describe("parseIpAddress()", () => {
    it("returns the bytes of an IPv4 or IPv6 address", () => {
      expect(parseIpAddress("192.0.2.10")).toEqual(
        Uint8Array.of(192, 0, 2, 10),
      );
      expect(parseIpAddress("::1")).toEqual(
        Uint8Array.of(...Array(15).fill(0), 1),
      );
      expect(parseIpAddress("::ffff:10.0.0.1")).toEqual(
        Uint8Array.of(...Array(10).fill(0), 0xff, 0xff, 10, 0, 0, 1),
      );
    });

    it("returns undefined for anything but an address written one way", () => {
      for (
        const text of [
          "localhost",
          "1.2.3",
          "1.2.3.256",
          "0177.0.0.1",
          "0x7f.0.0.1",
          "1..2.3",
          "+1.2.3.4",
          "::1::2",
          "",
        ]
      ) {
        expect(parseIpAddress(text)).toBeUndefined();
      }
    });
  });

  describe("isPublicAddress()", () => {
    it("returns true for unicast addresses on the open internet", () => {
      for (
        const text of [
          "93.184.215.14",
          "8.8.8.8",
          "2606:4700::1111",
          "::ffff:8.8.8.8",
          "64:ff9b::808:808",
        ]
      ) {
        expect(isPublicAddress(parsed(text))).toBe(true);
      }
    });

    it("returns false for this device, private networks and reserved addresses", () => {
      for (
        const text of [
          "127.0.0.1",
          "10.0.0.1",
          "100.64.0.1",
          "169.254.169.254",
          "172.16.0.1",
          "192.168.0.1",
          "192.0.2.1",
          "224.0.0.1",
          "0.0.0.0",
          "::1",
          "::",
          "fc00::1",
          "fe80::1",
          "ff02::1",
          "2001:db8::1",
          "2002::1",
          "2001::1",
          "2001:20::1",
          "3fff::1",
          "::ffff:127.0.0.1",
          "::ffff:10.1.2.3",
          "64:ff9b::a00:1",
        ]
      ) {
        expect(isPublicAddress(parsed(text))).toBe(false);
      }
    });
  });
});
