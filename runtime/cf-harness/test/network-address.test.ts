import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import {
  interfaceNetworks,
  isOpenInternetAddress,
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

  describe("isOpenInternetAddress()", () => {
    const networks = [
      { address: parsed("2a02:8071:1234:5600::1"), prefixLength: 64 },
      { address: parsed("2a02:8071:1234:5700::5"), prefixLength: 128 },
      { address: parsed("81.2.69.142"), prefixLength: 24 },
      { address: parsed("81.2.70.5"), prefixLength: 0 },
    ];

    it("returns false for a public address on one of the networks", () => {
      for (
        const text of [
          "2a02:8071:1234:5600::99",
          "2a02:8071:1234:5700::7",
          "81.2.69.160",
          "::ffff:81.2.69.160",
          "64:ff9b::5102:45a0",
          "81.2.70.5",
        ]
      ) {
        expect(isOpenInternetAddress(parsed(text), networks)).toBe(false);
      }
    });

    it("returns true for a public address on none of the networks", () => {
      for (
        const text of [
          "2a02:8071:1234:5601::99",
          "2a02:8071:1234:5701::7",
          "81.2.70.160",
          "::ffff:81.2.70.160",
          "81.2.70.6",
        ]
      ) {
        expect(isOpenInternetAddress(parsed(text), networks)).toBe(true);
      }
    });

    it("returns false for an address that is not public", () => {
      expect(isOpenInternetAddress(parsed("10.0.0.7"), [])).toBe(false);
      expect(isOpenInternetAddress(parsed("::ffff:127.0.0.1"), [])).toBe(
        false,
      );
    });
  });

  describe("interfaceNetworks()", () => {
    it("returns networks that keep this device's addresses, but not a distant one, off the open internet", () => {
      const networks = interfaceNetworks();
      expect(networks.length).toBeGreaterThan(0);
      for (const network of networks) {
        expect(Number.isInteger(network.prefixLength)).toBe(true);
        expect(isOpenInternetAddress(network.address, networks)).toBe(false);
      }
      expect(isOpenInternetAddress(parsed("8.8.8.8"), networks)).toBe(true);
      expect(isOpenInternetAddress(parsed("2001:4860:4860::8888"), networks))
        .toBe(true);
    });

    /** What Deno reports for an interface with `address` and `cidr`. */
    const interfaceInfo = (
      address: string,
      cidr: string,
    ): Deno.NetworkInterfaceInfo => ({
      family: address.includes(":") ? "IPv6" : "IPv4",
      name: "en0",
      address,
      netmask: "",
      scopeid: null,
      cidr,
      mac: "00:00:00:00:00:00",
    });

    it("throws for an interface whose prefix length is missing or does not fit its address", () => {
      for (
        const info of [
          interfaceInfo("81.2.69.142", "81.2.69.142"),
          interfaceInfo("81.2.69.142", "81.2.69.142/x"),
          interfaceInfo("81.2.69.142", "81.2.69.142/33"),
          interfaceInfo(
            "2a02:8071:1234:5600::1",
            "2a02:8071:1234:5600::1/129",
          ),
          interfaceInfo("en0", "en0/24"),
        ]
      ) {
        using _ = stub(Deno, "networkInterfaces", () => [info]);
        expect(() => interfaceNetworks()).toThrow("Not an interface network");
      }
    });

    it("reads a prefix length of 0 as one", () => {
      using _ = stub(
        Deno,
        "networkInterfaces",
        () => [interfaceInfo("81.2.70.5", "81.2.70.5/0")],
      );
      expect(interfaceNetworks()).toEqual([
        { address: parsed("81.2.70.5"), prefixLength: 0 },
      ]);
    });
  });
});
