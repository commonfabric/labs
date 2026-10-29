/**
 * What a `Browser` leaves behind: the directory its profile lived in, and the
 * targets its pages were opened as.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { removeDirectory } from "@commonfabric/utils/remove-directory";

import { Browser, PROFILE_DIRECTORY_PREFIX } from "../browser.ts";
import type { Page } from "../page.ts";

// How many pages the browser holds open, read from the browser rather than
// from what the tests opened, so a page astral closed only its own connection
// to still counts here.
async function openPages(browser: Browser): Promise<number> {
  const { host } = new URL(browser.wsEndpoint());
  const targets = await (await fetch(`http://${host}/json/list`)).json();
  return (targets as { type: string }[])
    .filter((target) => target.type === "page").length;
}

// Watches the browser's targets, so that a test can wait for the target `page`
// is open as to go.
//
// Closing a page asks the browser to close its target and returns on the
// browser's answer; the target is destroyed after that, so a target list read
// straight after a close can still hold the page. The watch is opened before
// the close, on a devtools connection of its own, so that nothing happens
// between the two.
async function watchTargetOf(
  browser: Browser,
  page: Page,
): Promise<{ gone: Promise<void> }> {
  // Astral names a page's devtools connection after the target it is open as,
  // which is where the id comes from.
  const { pathname } = new URL(
    page.astralPage.unsafelyGetCelestialBindings().ws.url,
  );
  const target = pathname.split("/").at(-1);
  if (target === undefined || target === "") {
    throw new Error(`No target id in the page's devtools url: ${pathname}`);
  }

  const socket = new WebSocket(browser.wsEndpoint());
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () =>
      reject(new Error("The browser refused a second devtools connection."));
  });

  const gone = new Promise<void>((resolve) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as {
        method?: string;
        params?: { targetId?: string };
      };
      if (
        message.method === "Target.targetDestroyed" &&
        message.params?.targetId === target
      ) {
        socket.close();
        resolve();
      }
    };
  });
  socket.send(JSON.stringify({
    id: 1,
    method: "Target.setDiscoverTargets",
    params: { discover: true },
  }));
  return { gone };
}

// The entries of `directory` whose names say a launch made them.
function profileDirectories(directory: string): string[] {
  return [...Deno.readDirSync(directory)]
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(PROFILE_DIRECTORY_PREFIX));
}

// Runs `body` with the environment variables `values` names set to what it
// gives them, and the rest of the environment as it was. A variable mapped to
// `undefined` is removed for the duration.
//
// The environment belongs to the process, so this holds only while one test
// runs at a time. `deno test` runs a file's tests in order unless it is given
// `--parallel`, which this package's test task does not.
async function withEnvironment(
  values: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const outer = Object.fromEntries(
    Object.keys(values).map((name) => [name, Deno.env.get(name)]),
  );
  const apply = (applied: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(applied)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  };
  apply(values);
  try {
    await body();
  } finally {
    apply(outer);
  }
}

// Runs `body` with `TMPDIR` naming a directory nothing else writes to, and
// removes that directory afterwards. `Deno.makeTempDir()` reads `TMPDIR` at
// each call, and the browser inherits it, so this covers what the launch makes
// and what the browser makes alike.
async function withTemporaryDirectory(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "integration-tmpdir-" });
  try {
    await withEnvironment({ TMPDIR: directory }, () => body(directory));
  } finally {
    await removeDirectory(directory);
  }
}

describe("browser", () => {
  describe("Browser", () => {
    describe("instance members", () => {
      describe("newPage()", () => {
        it("opens a page the browser gives up when the page closes", async () => {
          const browser = await Browser.launch();
          try {
            const page = await browser.newPage("about:blank");
            const opened = await openPages(browser);
            const watch = await watchTargetOf(browser, page);
            await page.close();
            await watch.gone;

            expect(await openPages(browser)).toBe(opened - 1);
          } finally {
            await browser.close();
          }
        });
      });

      describe("close()", () => {
        it("removes the profile directory the launch made", async () => {
          // The launch is given a `TMPDIR` of its own, and does not have it to
          // itself: Chrome writes its own scratch files into the directory
          // `TMPDIR` names and leaves some of them behind, files and
          // directories alike, and the processes it starts are re-parented when
          // the browser process goes, so more can land there after a browser
          // has closed. What a launch makes for itself carries
          // `PROFILE_DIRECTORY_PREFIX`, and the assertions read that.
          await withTemporaryDirectory(async (directory) => {
            // The page is served over HTTP so that the browser's network
            // service writes its cache into the profile, which is the writer
            // that puts a removed profile directory back.
            const server = Deno.serve(
              { port: 0, onListen: () => {} },
              () =>
                new Response("<!doctype html><title>profile</title>", {
                  headers: { "content-type": "text/html" },
                }),
            );
            const origin = `http://localhost:${
              (server.addr as Deno.NetAddr).port
            }`;

            let whileOpen: string[];
            try {
              const browser = await Browser.launch();
              whileOpen = profileDirectories(directory);
              try {
                const page = await browser.newPage(origin);
                await page.close();
              } finally {
                await browser.close();
              }
            } finally {
              await server.shutdown();
            }

            expect(whileOpen).toHaveLength(1);
            expect(profileDirectories(directory)).toEqual([]);
          });
        });

        it("refuses a page opened while it is still running", async () => {
          const browser = await Browser.launch();
          const closing = browser.close();

          await expect(browser.newPage()).rejects.toThrow(
            "Browser is already closed.",
          );
          await closing;
        });
      });
    });

    describe("static members", () => {
      describe("launch()", () => {
        it("removes the profile directory when the browser cannot be spawned", async () => {
          await withTemporaryDirectory(async (directory) => {
            // As above, the launch writes into a `TMPDIR` of its own.
            // `astralBinaryPath()` reports `ASTRAL_BIN_PATH` ahead of anything
            // it finds installed, so a path with no file behind it is a launch
            // that fails at the spawn, before any browser exists to close.
            await withEnvironment(
              { ASTRAL_BIN_PATH: `${directory}/no-such-browser` },
              async () => {
                await expect(Browser.launch()).rejects.toThrow();
              },
            );

            expect(profileDirectories(directory)).toEqual([]);
          });
        });
      });
    });
  });
});
