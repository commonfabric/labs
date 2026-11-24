/**
 * The space a command acts on may be stated once in `CF_SPACE` rather than on
 * every invocation, and `--space` overrides it.
 *
 * Four command trees declare the space option through different builders — the
 * shared target options in `piece.ts`, and `globalEnv`/`env` in `acl.ts`,
 * `deps.ts` and `wish.ts` — so one of each is exercised here. A builder that
 * did not get the declaration reports the space as missing, which is the
 * signal each of these reads.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { argv, cf, stripAnsi } from "./utils.ts";

function errorText(stderr: string[]): string {
  return stderr.map(stripAnsi).join("\n");
}

const MISSING_SPACE = 'Missing required option: "--space"';

// Two well-formed space DIDs. Which one a command ends up targeting is what
// these tests read, so they only ever have to differ.
const AMBIENT = "did:key:z6MkqyUta9P4wHtvDmwebQtXBjyJ3bSzmY2wFEkPL9ZAdp4W";
const EXPLICIT = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";

// A reference carrying its own space. The command refuses when the space it
// targets disagrees with the one written here, and names both — which is what
// makes the effective space observable without a server to answer.
const REF =
  `/@${EXPLICIT}/of:fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34/`;

const FABRIC = {
  CF_API_URL: "https://toolshed.test",
  CF_IDENTITY: "/nonexistent/identity.key",
};

describe("an ambient space", () => {
  it("is required when neither the flag nor the variable supplies it", async () => {
    const { code, stderr } = await cf(argv`piece ls`, { env: FABRIC });
    expect(code).toBe(1);
    expect(errorText(stderr)).toContain(MISSING_SPACE);
  });

  it("supplies the space a piece command was not given", async () => {
    const { stderr } = await cf(argv`piece ls`, {
      env: { ...FABRIC, CF_SPACE: AMBIENT },
    });
    expect(errorText(stderr)).not.toContain(MISSING_SPACE);
  });

  it("supplies the space an acl command was not given", async () => {
    const { stderr } = await cf(argv`acl ls`, {
      env: { ...FABRIC, CF_SPACE: AMBIENT },
    });
    expect(errorText(stderr)).not.toContain(MISSING_SPACE);
  });

  it("is offered by a wish, whose space is optional and so reports nothing missing", async () => {
    // `wish` falls back to the identity's home space, so it never reports a
    // missing one and the signal the tests above read does not exist here.
    // What it does have is the declaration, which is absent when the command
    // does not read the variable.
    const { stdout } = await cf(argv`wish --help`);
    expect(stdout.map(stripAnsi).join("\n")).toContain("CF_SPACE");
  });

  it("supplies the space a deps command was not given", async () => {
    const { stderr } = await cf(argv`deps update nonexistent.tsx`, {
      env: { ...FABRIC, CF_SPACE: AMBIENT },
    });
    expect(errorText(stderr)).not.toContain(MISSING_SPACE);
  });

  it("is what the command targets when only the variable is set", async () => {
    // The reference names EXPLICIT, so a command targeting AMBIENT refuses and
    // names AMBIENT as the space it was pointed at.
    const { stderr } = await cf(argv`cell get ${REF}`, {
      env: { ...FABRIC, CF_SPACE: AMBIENT },
    });
    expect(errorText(stderr)).toContain(
      `the command targets space "${AMBIENT}"`,
    );
  });

  it("leaves the --url spelling working, rather than reading as a conflict", async () => {
    // `--url` carries its own space and refuses an explicit `--space` beside
    // it. An ambient one is not a second spelling of the target, so exporting
    // CF_SPACE for a session must not take the URL form away.
    const { stderr } = await cf(
      argv`piece ls --url http://localhost:9999/aspace`,
      {
        env: { ...FABRIC, CF_SPACE: AMBIENT },
      },
    );
    expect(errorText(stderr)).not.toContain(
      '"--space" cannot be provided when using "--url"',
    );
  });

  it("still refuses an explicit --space beside --url", async () => {
    const { stderr } = await cf(
      argv`piece ls --url http://localhost:9999/aspace --space ${EXPLICIT}`,
      { env: FABRIC },
    );
    expect(errorText(stderr)).toContain(
      '"--space" cannot be provided when using "--url"',
    );
  });

  it("refuses an explicit --space beside --url even when it names the ambient space", async () => {
    // The caller stated the target twice, which is what the refusal is for.
    // Deciding provenance by comparing the value against CF_SPACE would call
    // this one ambient and let it through.
    const { stderr } = await cf(
      argv`piece ls --url http://localhost:9999/aspace --space ${AMBIENT}`,
      { env: { ...FABRIC, CF_SPACE: AMBIENT } },
    );
    expect(errorText(stderr)).toContain(
      '"--space" cannot be provided when using "--url"',
    );
  });

  it("loses to the flag, which is what makes it safe to leave set", async () => {
    // A guard against a future precedence change rather than a test of this
    // one: the flag decided the space before the variable existed, so removing
    // the variable cannot make this fail. It is here because the variable is
    // only safe to leave set for a whole session if the flag keeps winning,
    // and nothing else states that.
    const { stderr } = await cf(argv`cell get ${REF} --space ${EXPLICIT}`, {
      env: { ...FABRIC, CF_SPACE: AMBIENT },
    });
    expect(errorText(stderr)).not.toContain("but the command targets space");
  });
});
