import { expect } from "@std/expect";

import { describe, it } from "@commonfabric/test-support/test";
import {
  type BrowserHostPage,
  browserHostPageFitsKind,
  type BrowserHostRequest,
  browserHostRequestProblem,
  isBrowserHostResult,
  isBrowserHostSessionName,
  isBrowserHostSite,
} from "../../src/contracts/browser-host.ts";

const SITE = "https://shop.example";

/** A page as a named session reports it. */
const PAGE = {
  url: "https://www.shop.example/cart",
  title: "Cart",
  site: SITE,
  sites: ["https://cdn.example", SITE],
};

/** A page as a locked-down session that is away reports it. */
const AWAY: BrowserHostPage = {
  url: "",
  title: "",
  site: "https://login.example",
  sites: ["https://login.example"],
  away: true,
  tls: false,
};

/** A page as a locked-down session that is not away reports it. */
const LOCKED = { ...PAGE, tls: true };

const ELEMENT = {
  role: "button",
  tag: "button",
  name: "Place order",
  isSubmit: true,
  formHas: { password: false, oneTimeCode: false, card: true },
};

const RELOAD: BrowserHostRequest = {
  session: "s1",
  operation: { action: "reload" },
};

const GET_URL: BrowserHostRequest = {
  session: "s1",
  operation: { action: "get", kind: "url" },
};

describe("browser-host", () => {
  describe("isBrowserHostSessionName", () => {
    it("returns true for 1 to 64 ASCII letters, digits, hyphens, and underscores", () => {
      for (const name of ["a", "Z", "research-1_b", "x".repeat(64)]) {
        expect(isBrowserHostSessionName(name)).toBe(true);
      }
    });

    it("returns false for anything else", () => {
      const names = ["", "x".repeat(65), "a b", "a.b", "a\n", "é", 7, null];
      for (const name of names) {
        expect(isBrowserHostSessionName(name)).toBe(false);
      }
    });
  });

  describe("browserHostPageFitsKind", () => {
    it("returns true for a page carrying tls exactly when the session is locked down", () => {
      expect(browserHostPageFitsKind(LOCKED, "locked-down")).toBe(true);
      expect(browserHostPageFitsKind(AWAY, "locked-down")).toBe(true);
      expect(browserHostPageFitsKind(PAGE, "read-only")).toBe(true);
    });

    it("returns false for a locked-down page without tls, or a read-only page with it", () => {
      expect(browserHostPageFitsKind(PAGE, "locked-down")).toBe(false);
      expect(browserHostPageFitsKind(LOCKED, "read-only")).toBe(false);
    });
  });

  describe("isBrowserHostSite", () => {
    it("returns true for a scheme and a lowercase domain of two or more labels", () => {
      const sites = [
        SITE,
        "http://a.b",
        "https://example.co.uk",
        "https://xn--bcher-kva.example",
      ];
      for (const site of sites) {
        expect(isBrowserHostSite(site)).toBe(true);
      }
    });

    it("returns false for an address, a port, a trailing dot, one label, an IP literal, a label edged with a hyphen, uppercase, or another scheme", () => {
      const sites = [
        "https://shop.example/",
        "https://shop.example/cart?id=1",
        "https://shop.example:443",
        "https://shop.example.",
        "https://localhost",
        "https://127.0.0.1",
        "https://-shop.example",
        "https://shop-.example",
        "https://shop.123",
        "https://Shop.example",
        "ftp://shop.example",
        "shop.example",
        7,
      ];
      for (const site of sites) {
        expect(isBrowserHostSite(site)).toBe(false);
      }
    });
  });

  describe("browserHostRequestProblem", () => {
    it("returns undefined for a well-formed request", () => {
      const requests: BrowserHostRequest[] = [
        { operation: { action: "reload" } },
        RELOAD,
        {
          session: "s2",
          operation: { action: "session-open", kind: "read-only", url: SITE },
        },
        { operation: { action: "session-list" } },
      ];
      for (const request of requests) {
        expect(browserHostRequestProblem(request)).toBeUndefined();
      }
    });

    it("returns the problem with a malformed name, a session-open or session-close naming no session, and a session-list naming one", () => {
      expect(
        browserHostRequestProblem({
          session: "a b",
          operation: { action: "reload" },
        }),
      ).toBe(
        "a session name is 1 to 64 ASCII letters, digits, hyphens, and underscores",
      );
      expect(
        browserHostRequestProblem({
          operation: { action: "session-open", kind: "locked-down", url: SITE },
        }),
      ).toBe("`session-open` names a session");
      expect(
        browserHostRequestProblem({ operation: { action: "session-close" } }),
      ).toBe("`session-close` names a session");
      expect(
        browserHostRequestProblem({
          session: "s1",
          operation: { action: "session-list" },
        }),
      ).toBe("`session-list` is sent with no session");
    });
  });

  describe("isBrowserHostResult", () => {
    describe("pages", () => {
      it("returns true for an unnamed session's page with sites or without them", () => {
        const unnamed: BrowserHostRequest = { operation: { action: "reload" } };
        const old = { url: "https://shop.example/", title: "Shop" };

        expect(isBrowserHostResult({ status: "ok", page: old }, unnamed))
          .toBe(true);
        expect(isBrowserHostResult({ status: "ok", page: PAGE }, unnamed))
          .toBe(true);
      });

      it("returns false for an unnamed session's page with only one of site and sites, or away", () => {
        const unnamed: BrowserHostRequest = { operation: { action: "reload" } };
        const pages = [
          { url: "https://shop.example/", title: "Shop", site: SITE },
          { url: "https://shop.example/", title: "Shop", sites: [SITE] },
          { ...AWAY },
        ];
        for (const page of pages) {
          expect(isBrowserHostResult({ status: "ok", page }, unnamed))
            .toBe(false);
        }
      });

      it('returns true for a named session\'s page whose site, or "null" for none, is among its sites', () => {
        const pages = [
          PAGE,
          { ...PAGE, site: null, sites: ["null"] },
          { ...PAGE, site: null, sites: ["https://ads.example", "null"] },
          { ...PAGE, sites: [...PAGE.sites, "null"] },
        ];
        for (const page of pages) {
          expect(isBrowserHostResult({ status: "ok", page }, RELOAD))
            .toBe(true);
        }
      });

      it("returns false for a named session's page without sites, with its site missing from them, or with sites out of order, repeated, or malformed", () => {
        const { site: _site, sites: _sites, ...bare } = PAGE;
        const pages = [
          bare,
          { ...PAGE, sites: ["https://cdn.example"] },
          { ...PAGE, site: null, sites: [] },
          { ...PAGE, site: null },
          { ...PAGE, sites: [SITE, "https://cdn.example"] },
          { ...PAGE, sites: ["https://cdn.example", SITE, SITE] },
          { ...PAGE, sites: ["https://cdn.example/", SITE] },
          { ...PAGE, sites: ["null", ...PAGE.sites] },
          { ...PAGE, sites: [...PAGE.sites, "none"] },
          { ...PAGE, sites: [...PAGE.sites, null] },
          { ...PAGE, site: "https://shop.example/cart" },
          { ...PAGE, sites: SITE },
        ];
        for (const page of pages) {
          expect(isBrowserHostResult({ status: "ok", page }, RELOAD))
            .toBe(false);
        }
      });

      it("returns true for a named session's page with tls either way", () => {
        for (const tls of [true, false]) {
          expect(
            isBrowserHostResult(
              { status: "ok", page: { ...PAGE, tls } },
              RELOAD,
            ),
          ).toBe(true);
        }
      });

      it("returns false for tls that is not a boolean, tls on the unnamed session's page, or an away page without tls false", () => {
        const unnamed: BrowserHostRequest = { operation: { action: "reload" } };
        const old = { url: "https://shop.example/", title: "Shop" };
        const urlRef = { kind: "url-ref", ref: "u1" };
        const { tls: _tls, ...untold } = AWAY;

        expect(
          isBrowserHostResult(
            { status: "ok", page: { ...PAGE, tls: "yes" } },
            RELOAD,
          ),
        ).toBe(false);
        expect(isBrowserHostResult({ status: "ok", page: LOCKED }, unnamed))
          .toBe(false);
        expect(
          isBrowserHostResult(
            { status: "ok", page: { ...old, tls: true } },
            unnamed,
          ),
        ).toBe(false);
        for (const page of [untold, { ...AWAY, tls: true }]) {
          expect(isBrowserHostResult({ status: "ok", page, urlRef }, GET_URL))
            .toBe(false);
        }
      });

      it("returns true for an away page with no address and no title, on a refusal or with a URL reference", () => {
        const urlRef = { kind: "url-ref", ref: "u1" };

        expect(
          isBrowserHostResult(
            { status: "off-site", message: "away", page: AWAY },
            RELOAD,
          ),
        ).toBe(true);
        expect(
          isBrowserHostResult({ status: "ok", page: AWAY, urlRef }, GET_URL),
        )
          .toBe(true);
      });

      it("returns false for an away page that carries an address, a title, text, or pixels", () => {
        const urlRef = { kind: "url-ref", ref: "u1" };
        const image = { mediaType: "image/png", base64: "iVBORw0KGgo=" };
        const results = [
          {
            status: "ok",
            page: { ...AWAY, url: "https://login.example/" },
            urlRef,
          },
          { status: "ok", page: { ...AWAY, title: "Sign in" }, urlRef },
          { status: "ok", page: { ...AWAY, away: false } },
          { status: "ok", page: AWAY, urlRef, text: "https://login.example/" },
          { status: "ok", page: AWAY, urlRef, image },
        ];
        for (const result of results) {
          expect(isBrowserHostResult(result, GET_URL)).toBe(false);
        }
      });

      it("returns true for a named session's get url with the address as a token, and as text unless away", () => {
        const urlRef = { kind: "url-ref", ref: "u1" };

        expect(
          isBrowserHostResult(
            { status: "ok", page: PAGE, text: PAGE.url, urlRef },
            GET_URL,
          ),
        ).toBe(true);
        expect(
          isBrowserHostResult({ status: "ok", page: AWAY, urlRef }, GET_URL),
        )
          .toBe(true);
      });

      it("returns false for a named session's get url without a token, or without the text while not away", () => {
        const urlRef = { kind: "url-ref", ref: "u1" };
        const results = [
          { status: "ok", page: AWAY },
          { status: "ok", page: PAGE, text: PAGE.url },
          { status: "ok", page: AWAY, urlRef: { kind: "url", ref: "u1" } },
          { status: "ok", page: PAGE, urlRef },
        ];
        for (const result of results) {
          expect(isBrowserHostResult(result, GET_URL)).toBe(false);
        }
      });

      it("returns false for a URL reference on any other result, the unnamed session's get url included", () => {
        const urlRef = { kind: "url-ref", ref: "u1" };
        const unnamed: BrowserHostRequest = {
          operation: { action: "get", kind: "url" },
        };
        const old = { url: "https://shop.example/", title: "Shop" };

        expect(
          isBrowserHostResult({ status: "ok", page: AWAY, urlRef }, RELOAD),
        )
          .toBe(false);
        expect(
          isBrowserHostResult(
            { status: "ok", page: old, text: old.url, urlRef },
            unnamed,
          ),
        ).toBe(false);
        expect(
          isBrowserHostResult(
            { status: "ok", page: old, text: old.url },
            unnamed,
          ),
        ).toBe(true);
      });
    });

    describe("page results", () => {
      it("returns true for text, pixels, and how a hand-off ended", () => {
        const image = { mediaType: "image/png", base64: "iVBORw0KGgo=" };

        expect(
          isBrowserHostResult(
            { status: "ok", page: PAGE, text: "- heading", image },
            RELOAD,
          ),
        ).toBe(true);
        expect(
          isBrowserHostResult(
            { status: "ok", page: PAGE, handoff: "declined" },
            RELOAD,
          ),
        ).toBe(true);
      });

      it("returns false without a page, for a page missing its title, or for text, pixels, or a hand-off of the wrong type", () => {
        const { title: _title, ...untitled } = PAGE;
        const results = [
          { status: "ok" },
          { status: "ok", page: untitled },
          { status: "ok", page: PAGE, text: 7 },
          {
            status: "ok",
            page: PAGE,
            image: { mediaType: "image/png", base64: 7 },
          },
          {
            status: "ok",
            page: PAGE,
            image: { mediaType: "image/gif", base64: "R0lGOD" },
          },
          { status: "ok", page: PAGE, handoff: "maybe" },
        ];
        for (const result of results) {
          expect(isBrowserHostResult(result, RELOAD)).toBe(false);
        }
      });
    });

    describe("refusals", () => {
      it("returns false for a refusal whose page is not one the session reports", () => {
        const old = { url: "https://shop.example/", title: "Shop" };
        const refusal = { status: "failed", message: "m", page: old };

        expect(isBrowserHostResult(refusal, RELOAD)).toBe(false);
        expect(
          isBrowserHostResult(refusal, { operation: { action: "reload" } }),
        ).toBe(true);
        expect(
          isBrowserHostResult(
            { status: "failed", message: "m", page: { ...PAGE, title: 7 } },
            RELOAD,
          ),
        ).toBe(false);
      });

      it("returns false for a refusal with a message that is not text, a URL reference, or text beside an away page", () => {
        const urlRef = { kind: "url-ref", ref: "u1" };
        const results = [
          { status: "failed", message: 7 },
          { status: "off-site", message: "m", page: AWAY, urlRef },
          { status: "off-site", message: "m", page: AWAY, text: "the page" },
        ];
        for (const result of results) {
          expect(isBrowserHostResult(result, GET_URL)).toBe(false);
        }
      });

      it("returns true for off-site and wrong-kind, and false for a status it does not know", () => {
        expect(
          isBrowserHostResult({ status: "off-site", message: "m" }, RELOAD),
        )
          .toBe(true);
        expect(
          isBrowserHostResult({ status: "wrong-kind", message: "m" }, RELOAD),
        ).toBe(true);
        expect(
          isBrowserHostResult({ status: "elsewhere", message: "m" }, RELOAD),
        )
          .toBe(false);
      });
    });

    describe("session-open", () => {
      const open = (
        kind: "read-only" | "locked-down",
      ): BrowserHostRequest => ({
        session: "s2",
        operation: { action: "session-open", kind, url: SITE },
      });

      it("returns true when the session reported is of the kind asked for, bound to a site when locked down", () => {
        expect(
          isBrowserHostResult(
            {
              status: "ok",
              page: LOCKED,
              session: { kind: "locked-down", site: SITE },
            },
            open("locked-down"),
          ),
        ).toBe(true);
        expect(
          isBrowserHostResult(
            {
              status: "ok",
              page: { ...PAGE, site: null, sites: ["null"] },
              session: { kind: "read-only", site: null },
            },
            open("read-only"),
          ),
        ).toBe(true);
      });

      it("returns false without the session, for another kind, or for a locked-down session bound to no site", () => {
        const results = [
          { status: "ok", page: PAGE },
          {
            status: "ok",
            page: PAGE,
            session: { kind: "read-only", site: SITE },
          },
          {
            status: "ok",
            page: LOCKED,
            session: { kind: "locked-down", site: null },
          },
          {
            status: "ok",
            page: LOCKED,
            session: { kind: "locked-down", site: "x" },
          },
          { status: "ok", session: { kind: "locked-down", site: SITE } },
          {
            status: "ok",
            page: LOCKED,
            session: { kind: "locked-down", site: "https://cdn.example" },
          },
        ];
        for (const result of results) {
          expect(isBrowserHostResult(result, open("locked-down"))).toBe(false);
        }
      });

      it("returns false for a locked-down session away on its own site, or not away on another", () => {
        const results = [
          {
            status: "ok",
            page: { ...AWAY, site: SITE, sites: [SITE] },
            session: { kind: "locked-down", site: SITE },
          },
          {
            status: "ok",
            page: { ...LOCKED, site: "https://cdn.example" },
            session: { kind: "locked-down", site: SITE },
          },
        ];
        for (const result of results) {
          expect(isBrowserHostResult(result, open("locked-down"))).toBe(false);
        }
      });

      it("returns false for a locked-down session's page without tls, or a read-only session's page with it", () => {
        expect(
          isBrowserHostResult(
            {
              status: "ok",
              page: PAGE,
              session: { kind: "locked-down", site: SITE },
            },
            open("locked-down"),
          ),
        ).toBe(false);
        expect(
          isBrowserHostResult(
            {
              status: "ok",
              page: LOCKED,
              session: { kind: "read-only", site: SITE },
            },
            open("read-only"),
          ),
        ).toBe(false);
      });

      it("returns false for a read-only session reported away", () => {
        expect(
          isBrowserHostResult(
            {
              status: "ok",
              page: AWAY,
              session: { kind: "read-only", site: SITE },
            },
            open("read-only"),
          ),
        ).toBe(false);
      });

      it("returns true for a locked-down session bound to another site than the page it went straight on to", () => {
        expect(
          isBrowserHostResult(
            {
              status: "ok",
              page: AWAY,
              session: { kind: "locked-down", site: SITE },
            },
            open("locked-down"),
          ),
        ).toBe(true);
      });
    });

    describe("session-close", () => {
      const close: BrowserHostRequest = {
        session: "s2",
        operation: { action: "session-close" },
      };

      it("returns true for an ok with no page, ignoring fields it does not know", () => {
        expect(isBrowserHostResult({ status: "ok" }, close)).toBe(true);
        expect(isBrowserHostResult({ status: "ok", closed: 1 }, close))
          .toBe(true);
      });

      it("returns false for an ok carrying a page that is not one", () => {
        expect(isBrowserHostResult({ status: "ok", page: { url: 7 } }, close))
          .toBe(false);
      });
    });

    describe("session-list", () => {
      const list: BrowserHostRequest = {
        operation: { action: "session-list" },
      };

      it("returns true for a refusal, which carries no list", () => {
        expect(isBrowserHostResult({ status: "failed", message: "m" }, list))
          .toBe(true);
      });

      it("returns true for a list of the open sessions", () => {
        const sessions = [
          { name: "bank", kind: "locked-down", site: SITE, away: true },
          { name: "r1", kind: "read-only", site: null, away: false },
        ];

        expect(isBrowserHostResult({ status: "ok", sessions }, list)).toBe(
          true,
        );
        expect(isBrowserHostResult({ status: "ok", sessions: [] }, list))
          .toBe(true);
      });

      it("returns false without the list, or for an entry with a malformed name, an away read-only session, or a locked-down one bound to no site", () => {
        const entry = {
          name: "bank",
          kind: "locked-down",
          site: SITE,
          away: false,
        };
        const lists = [
          undefined,
          entry,
          [{ ...entry, name: "a b" }],
          [{ ...entry, kind: "read-only", away: true }],
          [{ ...entry, site: null }],
          [{ ...entry, away: "no" }],
          [{ ...entry, kind: "signed-in" }],
        ];
        for (const sessions of lists) {
          expect(isBrowserHostResult({ status: "ok", sessions }, list))
            .toBe(false);
        }
      });
    });

    describe("sign-in", () => {
      const signIn = (
        from: "weaver-profile" | "owner",
      ): BrowserHostRequest => ({
        session: "bank",
        operation: { action: "sign-in", from },
      });

      it("returns true for the count of cookies copied, with how the owner ended it when they were asked", () => {
        expect(
          isBrowserHostResult(
            { status: "ok", page: PAGE, signIn: { copied: 3 } },
            signIn("weaver-profile"),
          ),
        ).toBe(true);
        expect(
          isBrowserHostResult(
            {
              status: "ok",
              page: PAGE,
              signIn: { copied: 0 },
              handoff: "declined",
            },
            signIn("owner"),
          ),
        ).toBe(true);
      });

      it("returns false without a count, for a count that is not one, or with a hand-off exactly when the owner was not asked", () => {
        const results: [unknown, "weaver-profile" | "owner"][] = [
          [{ status: "ok", page: PAGE }, "weaver-profile"],
          [
            { status: "ok", page: PAGE, signIn: { copied: -1 } },
            "weaver-profile",
          ],
          [
            { status: "ok", page: PAGE, signIn: { copied: 1.5 } },
            "weaver-profile",
          ],
          [
            { status: "ok", page: PAGE, signIn: { copied: "3" } },
            "weaver-profile",
          ],
          [
            {
              status: "ok",
              page: PAGE,
              signIn: { copied: 3 },
              handoff: "done",
            },
            "weaver-profile",
          ],
          [{ status: "ok", page: PAGE, signIn: { copied: 3 } }, "owner"],
        ];
        for (const [result, from] of results) {
          expect(isBrowserHostResult(result, signIn(from))).toBe(false);
        }
      });
    });

    describe("evaluate", () => {
      const evaluate: BrowserHostRequest = {
        session: "r1",
        operation: { action: "evaluate", script: "document.title" },
      };

      it("returns true only with the completion value's text", () => {
        expect(
          isBrowserHostResult(
            { status: "ok", page: PAGE, text: '"Cart"' },
            evaluate,
          ),
        ).toBe(true);
        expect(isBrowserHostResult({ status: "ok", page: PAGE }, evaluate))
          .toBe(false);
      });
    });

    describe("describe", () => {
      const describeRef: BrowserHostRequest = {
        session: "bank",
        operation: { action: "describe", ref: "@e4" },
      };

      it("returns true for the element's facts, with or without its input type and autocomplete", () => {
        const elements = [
          ELEMENT,
          { ...ELEMENT, inputType: "submit", autocomplete: "off" },
        ];
        for (const element of elements) {
          expect(
            isBrowserHostResult(
              { status: "ok", page: PAGE, element },
              describeRef,
            ),
          ).toBe(true);
        }
      });

      it("returns false without the element, or for one missing a fact or with a fact of the wrong type", () => {
        const { name: _name, ...nameless } = ELEMENT;
        const elements = [
          undefined,
          nameless,
          { ...ELEMENT, isSubmit: "yes" },
          { ...ELEMENT, inputType: 7 },
          { ...ELEMENT, autocomplete: false },
          { ...ELEMENT, formHas: { password: false, oneTimeCode: false } },
          { ...ELEMENT, formHas: null },
        ];
        for (const element of elements) {
          expect(
            isBrowserHostResult(
              { status: "ok", page: PAGE, element },
              describeRef,
            ),
          ).toBe(false);
        }
      });
    });
  });
});
