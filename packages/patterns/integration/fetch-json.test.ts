import { env, Page } from "@commonfabric/integration";
import { sleep } from "@commonfabric/utils/sleep";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForText } from "./cfc-browser-helpers.ts";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { TEST_HTTP } from "./flags.ts";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const ignore = !TEST_HTTP;

// Fetch data tests may require network access and are skipped in CI until we handle external dependencies properly in CI environments.
// This requires either:
// 1. Adding a flag to enable network tests in CI with proper mocking
// 2. Using mock data or fixtures for CI testing
describe("fetch json integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;

  if (!ignore) {
    beforeAll(async () => {
      identity = await Identity.generate({ implementation: "noble" });
      cc = await initializePiecesController({
        space: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: identity,
      });
      piece = await cc.create(
        await Deno.readTextFile(
          join(
            import.meta.dirname!,
            "..",
            "examples",
            "fetch-json.tsx",
          ),
        ),
        { start: true },
      );
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });
  }

  it({
    name: "should load the github fetcher piece and verify initial state",
    ignore,
    fn: async () => {
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceId: piece.id,
        },
        identity,
      });

      await waitForTitle("next.js", page);

      // Also verify via direct operations
      const repoUrl = await piece.input.get(["repoUrl"]);
      assertEquals(repoUrl, "https://github.com/vercel/next.js");
    },
  });

  it({
    name: "should update repo URL and verify data refetches",
    ignore,
    fn: async () => {
      const page = shell.page();

      // Set new repo URL via direct operation
      await piece.input.set(
        "https://github.com/commonfabric/labs",
        ["repoUrl"],
      );

      await sleep(200);

      // Navigate to the piece to see updated data
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceId: piece.id,
        },
        identity,
      });

      await waitForTitle("labs", page);

      // Also verify via direct operations
      const repoUrl = await piece.input.get(["repoUrl"]);
      assertEquals(repoUrl, "https://github.com/commonfabric/labs");
    },
  });
});

async function waitForTitle(title: string, page: Page) {
  await waitForText(page, "#github-title", title);
}
