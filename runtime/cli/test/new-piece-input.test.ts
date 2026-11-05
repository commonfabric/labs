import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { newPieceFromCommand, piece } from "../commands/piece.ts";
import { newPiece } from "../lib/piece.ts";
import { captureStderr } from "./utils.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "shared-note-input",
  identity: "/unused/test.key",
  quiet: true,
};
const INPUT = {
  title: "Team notes",
  content: "---\ntitle: Keep me\n---\r\n# Notes\n\n`literal ${text}` 😀\n",
};

describe("piece creation input", () => {
  it("declares the input file option on piece new", () => {
    expect(piece.getCommand("new")?.getOption("input-file")).toBeDefined();
  });

  it("reads a JSON object before creation without changing Markdown", async () => {
    const path = await Deno.makeTempFile();
    try {
      await Deno.writeTextFile(path, JSON.stringify(INPUT));
      let received: unknown;
      await captureStderr(() =>
        newPieceFromCommand(
          { ...CONFIG, inputFile: path, requestKey: "import-attempt" },
          "/repo/main.tsx",
          {
            newPiece: (_config, _entry, options) => {
              received = options;
              return Promise.resolve("fid1:created");
            },
          },
        )
      );
      expect(received).toMatchObject({
        input: INPUT,
        requestKey: "import-attempt",
      });
    } finally {
      await Deno.remove(path);
    }
  });

  for (const text of ["null", "[]", '"text"', "1", "{"]) {
    it(`refuses ${JSON.stringify(text)} before creating a piece`, async () => {
      const path = await Deno.makeTempFile();
      let created = false;
      try {
        await Deno.writeTextFile(path, text);
        await expect(newPieceFromCommand(
          { ...CONFIG, inputFile: path },
          "/repo/main.tsx",
          {
            newPiece: () => {
              created = true;
              return Promise.resolve("fid1:unwanted");
            },
          },
        )).rejects.toThrow();
        expect(created).toBe(false);
      } finally {
        await Deno.remove(path);
      }
    });
  }

  for (const served of [false, true]) {
    it(`initializes content during ${served ? "served" : "client"} creation`, async () => {
      let received: unknown;
      const dependencies: NonNullable<Parameters<typeof newPiece>[3]> = {
        loadPieces: () =>
          Promise.resolve({
            runtime: { experimental: { serverExecution: served } },
            getSpace: () => "did:key:test-space",
            ensureDefaultPattern: () => Promise.resolve(),
            create: (_program: unknown, options: unknown) => {
              received = options;
              return Promise.resolve({
                id: "fid1:created",
                getCell: () => ({}),
              });
            },
            add: () => Promise.resolve(),
            getPieceCell: () => Promise.resolve({}),
          } as never),
        getPinnedProgramFromFile: () =>
          Promise.resolve({ main: "/main.tsx", files: [] }),
        loadIdentity: () => Promise.resolve({} as never),
        instantiatePieceOnServer: (_config, request) => {
          received = request;
          return Promise.resolve({
            pieceId: "fid1:created",
            pattern: { identity: "pattern", symbol: "default" },
            requestKey: "import-attempt",
            registration: { status: "handled" },
          });
        },
      };
      expect(
        await newPiece(
          CONFIG,
          { mainPath: "/main.tsx" },
          {
            input: INPUT,
            start: false,
            ...(served ? { requestKey: "import-attempt" } : {}),
          },
          dependencies,
        ),
      ).toBe("fid1:created");
      expect(received).toMatchObject(
        served
          ? { argument: INPUT, requestKey: "import-attempt", start: false }
          : { input: INPUT, start: false },
      );
    });
  }
});
