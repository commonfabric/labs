/**
 * The shell opening `/<space>/<collection>/<member>` in a browser, over a real
 * board filed by `cf`.
 *
 * What is proven here and nowhere else is the whole chain standing up at once:
 * a slug bound inside a piece, a worker resolving the reference through it,
 * and a rendered page that is the member rather than the board.
 */

import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { toCompactDebugString } from "@commonfabric/data-model";
import type { Identity } from "@commonfabric/identity";
import {
  env,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { writeTempIdentity } from "@commonfabric/integration/temp-identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { PiecesController } from "@commonfabric/piece/ops";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import "../src/globals.ts";

const { API_URL, SPACE_NAME, FRONTEND_URL } = env;
const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const BOARD_SOURCE = join(
  REPO_ROOT,
  "packages",
  "patterns",
  "collection-naming",
  "board.tsx",
);
const decoder = new TextDecoder();

/**
 * Run one `cf` command against the space these tests share. The identity and
 * server flags land between `args` and `tail`, because a callable name opens
 * the section its own arguments sit in: `cf piece call` reads everything past
 * the name as the handler's input.
 */
async function cf(
  identityPath: string,
  args: string[],
  tail: string[] = [],
): Promise<string> {
  // Through the temporary lock, because a nested Deno resolves dependencies
  // of its own and would refresh the repository's `deno.lock` as a side
  // effect of a test that only means to read a board back.
  const result = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--lock",
      lockPath,
      "-A",
      join(REPO_ROOT, "packages", "cli", "mod.ts"),
      ...args,
      "--identity",
      identityPath,
      "--api-url",
      API_URL,
      "--space",
      SPACE_NAME,
      ...tail,
    ],
    env: { CF_LOG_LEVEL: "error" },
  });
  const stdout = decoder.decode(result.stdout);
  if (!result.success) {
    const written = [...args, ...tail].join(" ");
    throw new Error(
      `cf ${written} failed with ${result.code}\nstdout:\n${stdout}` +
        `\nstderr:\n${decoder.decode(result.stderr)}`,
    );
  }
  return stdout;
}

/** File an exemplar pattern, and return its piece id. */
async function filePiece(
  identityPath: string,
  source: string,
): Promise<string> {
  const created = await cf(identityPath, ["piece", "new", source]);
  const pieceId = created.match(/fid1:[^\s]+/)?.[0];
  if (!pieceId) {
    throw new Error(`cf piece new did not print a fid1 id:\n${created}`);
  }
  return pieceId;
}

/**
 * File the exemplar board, give it one member per title, and bind `slug` to
 * the map it keeps them in. That binding is what makes `<slug>/<member>` an
 * address: the slug points inside the board rather than at its root, which is
 * what tells a resolver it names a collection.
 */
async function fileBoardWithMembers(
  identity: Identity,
  identityPath: string,
  slug: string,
  titles: readonly string[],
): Promise<string> {
  if (titles.length === 0) {
    throw new Error("A collection fixture needs at least one member.");
  }
  const boardId = await filePiece(identityPath, BOARD_SOURCE);
  // Through the board's own verb, which is the only way a client files a
  // member: `addItem` allocates the next name, creates the member holding
  // it, and appends the member, all in the write its own run mints. Seeding
  // the namespace from here instead writes that name from the test's client,
  // over a board shape no client produces.
  for (const [index, title] of titles.entries()) {
    // Projected to the allocated name alone: the unprojected result carries
    // the created member's whole rendered view. The name is read here rather
    // than assumed, so a namespace that stops being dense from 1 fails at the
    // call that allocated it and says what it allocated.
    const called = await cf(
      identityPath,
      ["piece", "call", "--cell", `/of:${boardId}`, "--quiet"],
      [
        "addItem",
        JSON.stringify({ title, agentName: "shell integration" }),
        "--",
        "--schema",
        JSON.stringify({ properties: { name: { type: "string" } } }),
      ],
    );
    const { result } = JSON.parse(called) as { result: { name: string } };
    expect(result.name).toBe(String(index + 1));
  }

  // Prove that fresh readers see each exact member before publishing the
  // collection's name.
  for (const [index, title] of titles.entries()) {
    const pieces = await PiecesController.initialize({
      apiUrl: new URL(API_URL),
      identity,
      space: SPACE_NAME,
    });
    try {
      const board = await pieces.get(boardId, true);
      const memberName = String(index + 1);
      const memberSlot = (await board.result.getCell())
        .key("names")
        .key(memberName);
      // The namespace deliberately keeps an unread link. Wait for that stored
      // slot first, then open its piece to derive the member's own result.
      await memberSlot.pull();
      await waitForCellValue(
        pieces.runtime,
        memberSlot,
        () => memberSlot.getRaw({ lastNode: "value" }) !== undefined,
        { stuckLabel: "collection member link publication" },
      );
      // Server execution derives only fields a subscription's schema reaches,
      // so this readiness read demands the two fields it checks.
      const member = await pieces.getPieceCell(memberSlot, true, {
        type: "object",
        properties: {
          title: { type: "string" },
          shortName: { type: "string" },
        },
        required: ["title", "shortName"],
      });
      await member.pull();
      let observed: unknown;
      try {
        await waitForCellValue<{ title?: string; shortName?: string }>(
          pieces.runtime,
          member,
          (value) => {
            observed = value === undefined
              ? undefined
              : { title: value.title, shortName: value.shortName };
            return value?.title === title && value?.shortName === memberName;
          },
          { stuckLabel: "collection member result publication" },
        );
      } catch (cause) {
        throw new Error(
          `Collection member publication failed: ${
            toCompactDebugString({
              expected: { title, shortName: memberName },
              observed,
              member: member.getAsNormalizedFullLink(),
            })
          }`,
          { cause },
        );
      }
    } finally {
      await pieces.dispose();
    }
  }

  await cf(identityPath, [
    "piece",
    "set-slug",
    slug,
    `/of:${boardId}/names`,
  ]);
  return boardId;
}

/** Whether the rendered view shows one member with the expected name. */
function memberNameIs(
  probe: ProbeApi,
  expected: string,
): boolean {
  const badges = probe.collect("[data-member-name]");
  return badges.length === 1 &&
    probe.deepText(badges[0]).trim() === expected;
}

describe("shell collection members", () => {
  // Two suites because they tolerate different things. Opening a member must
  // record no console error at all; only the suite whose subject IS a failed
  // load allows the one that failure reports, so a regression breaking the
  // happy path cannot hide inside an allowance written for the other.
  describe("opening one", () => {
    const shell = new ShellIntegration();
    shell.bindLifecycle();

    it("opens the member a collection reference names", async () => {
      await using tempIdentity = await writeTempIdentity({
        implementation: "noble",
      });
      const { identity, path: identityPath } = tempIdentity;
      const slug = `members-${crypto.randomUUID()}`;
      await fileBoardWithMembers(identity, identityPath, slug, [
        "Glaze recipes",
        "Oven schedule",
      ]);

      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: SPACE_NAME, pieceSlug: slug, pieceMember: "2" },
        identity,
      });

      // One badge, reading the board's name for this member. The board
      // renders one per item, so a page carrying exactly one is the member's.
      await waitForCondition(shell.page(), memberNameIs, {
        args: ["2"],
      });
      const pathname = await shell.page().evaluate(() =>
        globalThis.location.pathname
      );
      expect(pathname).toBe(`/${SPACE_NAME}/${slug}/2`);
      // The tab names the piece the shell opened. Member 2 is the second item
      // filed, and the board would name itself for its item count instead.
      await waitForCondition(
        shell.page(),
        () => document.title === "Oven schedule",
      );
    });

    it("opens the reference the header hands out", async () => {
      await using tempIdentity = await writeTempIdentity({
        implementation: "noble",
      });
      const { identity, path: identityPath } = tempIdentity;
      const slug = `portable-${crypto.randomUUID()}`;
      await fileBoardWithMembers(identity, identityPath, slug, [
        "Glaze recipes",
        "Oven schedule",
      ]);

      // The header copies the reference it holds character for character, so
      // the one it holds on the member's page is what "Copy reference" copies.
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: SPACE_NAME, pieceSlug: slug, pieceMember: "2" },
        identity,
      });
      const reference = await waitForCondition(shell.page(), (probe) => {
        const [header] = probe.collect("x-header-view");
        const held = header && "pieceReference" in header
          ? header.pieceReference
          : undefined;
        return typeof held === "string" && held !== "" ? held : false;
      });
      expect(reference).toBe(`//${SPACE_NAME}/${slug}/2`);

      // `cf` reads it and reaches the same member: the second one filed.
      const title = await cf(identityPath, [
        "cell",
        "get",
        String(reference),
        "title",
      ]);
      expect(JSON.parse(title)).toBe("Oven schedule");

      // A page served at that address is the only place its whole trip is
      // visible: through the server that routes it, the browser that sends
      // it, and the shell that reads it back.
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: SPACE_NAME, pieceSlug: slug, pieceMember: "2" },
        urlPath: reference as `/${string}`,
        identity,
      });

      await waitForCondition(shell.page(), memberNameIs, {
        args: ["2"],
      });
      // The second slash is no part of the space, so the page the shell
      // settles on is the one it would have written itself.
      const pathname = await shell.page().evaluate(() =>
        globalThis.location.pathname
      );
      expect(pathname).toBe(`/${SPACE_NAME}/${slug}/2`);
    });

    it("opens an address that marks its space with a leading `@`", async () => {
      await using tempIdentity = await writeTempIdentity({
        implementation: "noble",
      });
      const { identity, path: identityPath } = tempIdentity;
      const slug = `marked-${crypto.randomUUID()}`;
      await fileBoardWithMembers(identity, identityPath, slug, [
        "Glaze recipes",
      ]);

      // Addresses in circulation carry this spelling of a reference, and a
      // page served at one opens the member it names.
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: SPACE_NAME, pieceSlug: slug, pieceMember: "1" },
        urlPath: `/@${SPACE_NAME}/${slug}/1`,
        identity,
      });

      await waitForCondition(shell.page(), memberNameIs, {
        args: ["1"],
      });
      // The mark says which segment is the space and is no part of it, so the
      // page the shell settles on is the one it would have written itself.
      const pathname = await shell.page().evaluate(() =>
        globalThis.location.pathname
      );
      expect(pathname).toBe(`/${SPACE_NAME}/${slug}/1`);
    });
  });

  describe("naming one that is not there", () => {
    const shell = new ShellIntegration({
      allowedConsoleErrors: ["[AppView] Failed to load selected piece:"],
    });
    shell.bindLifecycle();

    it("reports a member the collection does not hold, naming both", async () => {
      await using tempIdentity = await writeTempIdentity({
        implementation: "noble",
      });
      const { identity, path: identityPath } = tempIdentity;
      const slug = `missing-${crypto.randomUUID()}`;
      await fileBoardWithMembers(identity, identityPath, slug, [
        "Glaze recipes",
      ]);

      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: SPACE_NAME, pieceSlug: slug, pieceMember: "999" },
        identity,
      });

      await waitForCondition(
        shell.page(),
        (probe, expected: string) =>
          probe.collect(".load-error").some((element) => {
            const text = probe.deepText(element).replace(/\s+/g, " ").trim();
            return text.includes("We could not load this piece") &&
              text.includes(expected);
          }),
        { args: [`no member 999 in ${slug}`] },
      );
    });

    it("opens nothing for an address naming segments past a member, naming them", async () => {
      await using tempIdentity = await writeTempIdentity({
        implementation: "noble",
      });
      const { identity, path: identityPath } = tempIdentity;
      const slug = `nested-${crypto.randomUUID()}`;
      await fileBoardWithMembers(identity, identityPath, slug, [
        "Glaze recipes",
      ]);

      // Member 1 is held, so what refuses this page is its address rather
      // than the collection. The page is served at the longer address, and
      // the state it has to reach carries the segments past the member.
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceSlug: slug,
          pieceMember: "1",
          pieceExtraPath: "comments/7",
        },
        identity,
      });

      await waitForCondition(
        shell.page(),
        (probe, expected: string) =>
          probe.collect(".load-error").some((element) => {
            const text = probe.deepText(element).replace(/\s+/g, " ").trim();
            return text.includes("We could not load this piece") &&
              text.includes(expected);
          }),
        { args: [`no piece at comments/7 after member 1 in ${slug}`] },
      );
    });

    it("refuses a member after a slug naming a piece at its root, naming it", async () => {
      await using tempIdentity = await writeTempIdentity({
        implementation: "noble",
      });
      const { identity, path: identityPath } = tempIdentity;
      const slug = `root-${crypto.randomUUID()}`;
      // Bound to the board's root rather than to the map inside it, the slug
      // names a piece, and a segment after it has no collection to select
      // from. Only the real resolver says so.
      const boardId = await filePiece(identityPath, BOARD_SOURCE);
      await cf(identityPath, ["piece", "set-slug", slug, `/of:${boardId}`]);

      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: SPACE_NAME, pieceSlug: slug, pieceMember: "1" },
        identity,
      });

      await waitForCondition(
        shell.page(),
        (probe, expected: string) =>
          probe.collect(".load-error").some((element) => {
            const text = probe.deepText(element).replace(/\s+/g, " ").trim();
            return text.includes("We could not load this piece") &&
              text.includes(expected);
          }),
        {
          args: [
            `no member 1 in ${slug}, which names a piece rather than a collection`,
          ],
        },
      );
    });
  });
});
