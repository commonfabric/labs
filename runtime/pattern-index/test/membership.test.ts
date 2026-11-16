import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  decodeDelegation,
  Identity,
  issueDelegation,
  verifyDelegation,
} from "@commonfabric/identity";
import { fromBase64url } from "@commonfabric/bytes/base64url";
import {
  checkIndexChain,
  INDEX_COMMAND,
  INDEX_ROOT_COMMAND,
  indexProofs,
  issueIndexChain,
  issueRootMove,
  MAX_INDEX_CHAIN_LENGTH,
  MAX_SIGNER_LINK_SECONDS,
} from "../src/membership.ts";

const root = await Identity.fromPassphrase("index membership root");
const laptop = await Identity.fromPassphrase("index membership laptop");
const agent = await Identity.fromPassphrase("index membership agent");
const NOW = 1_800_000_000;

describe("membership", () => {
  describe("issueIndexChain()", () => {
    it("returns the root's own link about itself, for /index, expiring 90 days out by default", async () => {
      const chain = await issueIndexChain({
        issuer: root,
        to: laptop.did(),
        held: [],
        nowSeconds: NOW,
      });
      expect(chain).toHaveLength(1);
      const link = await decodeDelegation(chain[0]);
      await verifyDelegation(link);
      expect(link.payload).toMatchObject({
        iss: root.did(),
        aud: laptop.did(),
        sub: root.did(),
        cmd: INDEX_COMMAND,
        exp: NOW + MAX_SIGNER_LINK_SECONDS,
      });
    });

    it("issues onward behind the chain the issuer holds, about the same root", async () => {
      const held = await issueIndexChain({
        issuer: root,
        to: laptop.did(),
        held: [],
        nowSeconds: NOW,
      });
      const chain = await issueIndexChain({
        issuer: laptop,
        to: agent.did(),
        held,
        expiresAt: NOW + 3600,
        nowSeconds: NOW,
      });
      expect(chain).toHaveLength(2);
      expect(chain[0]).toEqual(held[0]);
      const link = await decodeDelegation(chain[1]);
      expect(link.payload).toMatchObject({
        iss: laptop.did(),
        aud: agent.did(),
        sub: root.did(),
        cmd: INDEX_COMMAND,
        exp: NOW + 3600,
      });
      const checked = await checkIndexChain(chain, agent.did(), NOW);
      expect(checked.root).toBe(root.did());
    });

    it("throws for an expiry further off than 90 days", async () => {
      await expect(issueIndexChain({
        issuer: root,
        to: laptop.did(),
        held: [],
        expiresAt: NOW + MAX_SIGNER_LINK_SECONDS + 1,
        nowSeconds: NOW,
      })).rejects.toThrow("within 90 days");
    });

    it("throws for an expiry that is not after now", async () => {
      await expect(issueIndexChain({
        issuer: root,
        to: laptop.did(),
        held: [],
        expiresAt: NOW,
        nowSeconds: NOW,
      })).rejects.toThrow("not after now");
    });

    it("throws for the issuer as its own audience", async () => {
      await expect(issueIndexChain({
        issuer: root,
        to: root.did(),
        held: [],
        nowSeconds: NOW,
      })).rejects.toThrow("issuing key itself");
    });

    it("throws for a held chain that ends at another key", async () => {
      const held = await issueIndexChain({
        issuer: root,
        to: laptop.did(),
        held: [],
        nowSeconds: NOW,
      });
      await expect(issueIndexChain({
        issuer: agent,
        to: root.did(),
        held,
        nowSeconds: NOW,
      })).rejects.toThrow("not at");
    });

    it("throws for a held chain whose link has lapsed", async () => {
      const held = await issueIndexChain({
        issuer: root,
        to: laptop.did(),
        held: [],
        expiresAt: NOW + 10,
        nowSeconds: NOW,
      });
      await expect(issueIndexChain({
        issuer: laptop,
        to: agent.did(),
        held,
        nowSeconds: NOW + 20,
      })).rejects.toThrow("expired");
    });

    it("throws for a held chain already as long as the index accepts", async () => {
      const keys = await Promise.all(
        Array.from(
          { length: MAX_INDEX_CHAIN_LENGTH + 1 },
          (_, i) => Identity.fromPassphrase(`index membership hop ${i}`),
        ),
      );
      let held: Uint8Array[] = [];
      for (let i = 0; i < MAX_INDEX_CHAIN_LENGTH; i++) {
        held = await issueIndexChain({
          issuer: keys[i],
          to: keys[i + 1].did(),
          held,
          nowSeconds: NOW,
        });
      }
      await expect(issueIndexChain({
        issuer: keys[MAX_INDEX_CHAIN_LENGTH],
        to: agent.did(),
        held,
        nowSeconds: NOW,
      })).rejects.toThrow(`longer than ${MAX_INDEX_CHAIN_LENGTH}`);
    });
  });

  describe("issueRootMove()", () => {
    it("returns a root-to-new-key delegation about the root for /index/root", async () => {
      const move = await issueRootMove({
        root,
        to: laptop.did(),
        nowSeconds: NOW,
      });
      expect(move.payload).toMatchObject({
        iss: root.did(),
        aud: laptop.did(),
        sub: root.did(),
        cmd: INDEX_ROOT_COMMAND,
        exp: NOW + MAX_SIGNER_LINK_SECONDS,
      });
    });
  });

  describe("checkIndexChain()", () => {
    it("throws for a link to the signer that never expires", async () => {
      const open = await issueDelegation(root, {
        aud: laptop.did(),
        sub: root.did(),
        cmd: INDEX_COMMAND,
        pol: [],
      });
      await expect(checkIndexChain([open.bytes], laptop.did(), NOW)).rejects
        .toThrow("within 90 days");
    });

    it("accepts an open-ended root link behind a bounded signer link", async () => {
      const open = await issueDelegation(root, {
        aud: laptop.did(),
        sub: root.did(),
        cmd: INDEX_COMMAND,
        pol: [],
      });
      const chain = await issueIndexChain({
        issuer: laptop,
        to: agent.did(),
        held: [open.bytes],
        nowSeconds: NOW,
      });
      const checked = await checkIndexChain(chain, agent.did(), NOW);
      expect(checked.signerLinkExpires).toBe(NOW + MAX_SIGNER_LINK_SECONDS);
    });

    it("throws for a link whose command is broader than /index", async () => {
      const broad = await issueDelegation(root, {
        aud: laptop.did(),
        sub: root.did(),
        cmd: "/",
        pol: [],
        exp: NOW + 60,
      });
      await expect(checkIndexChain([broad.bytes], laptop.did(), NOW)).rejects
        .toThrow("not exactly /index");
    });

    it("throws for a first link that is not about its issuer", async () => {
      const elsewhere = await issueDelegation(root, {
        aud: laptop.did(),
        sub: agent.did(),
        cmd: INDEX_COMMAND,
        pol: [],
        exp: NOW + 60,
      });
      await expect(checkIndexChain([elsewhere.bytes], laptop.did(), NOW))
        .rejects.toThrow("root's own");
    });
  });

  describe("indexProofs()", () => {
    it("returns each link as unpadded base64url that decodes back to its bytes", async () => {
      const chain = await issueIndexChain({
        issuer: root,
        to: laptop.did(),
        held: [],
        nowSeconds: NOW,
      });
      const [proof] = indexProofs(chain);
      expect(proof).not.toContain("=");
      expect(fromBase64url(proof)).toEqual(chain[0]);
    });
  });
});
