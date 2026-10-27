import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// Home's published result contract already contains these defaults. Newly
// required generated outputs do not need migration defaults, but removing an
// existing default is still a contract change: older consumers may rely on its
// materialization semantics. The generic compatibility gate does not reject
// default removal, so these source pins are the protection against silently
// changing Home's established result contract. Generic generated-output
// behavior is covered by the piece compatibility, CFC schema-merge, and
// vintage replay suites.

const read = (relPath: string): string =>
  Deno.readTextFileSync(new URL(relPath, import.meta.url));

describe("home result-default contract stability", () => {
  const home = read("./home.tsx");

  it("favorites rides Default<[]>", () => {
    expect(home).toContain("favorites: Writable<Favorite[] | Default<[]>>");
  });

  it("journal rides Default<[]>", () => {
    expect(home).toContain("journal: Writable<JournalEntry[] | Default<[]>>");
  });

  it("spaces rides Default<[]>", () => {
    expect(home).toContain("spaces: Writable<SpaceEntry[] | Default<[]>>");
  });

  it('defaultAppUrl rides Default<"">', () => {
    expect(home).toContain('defaultAppUrl: Writable<string | Default<"">>');
  });

  it("profiles rides Default<TrustedProfileList, []> (wrapper-outside)", () => {
    // The empty default wraps the write contract: a Home without a stored
    // profiles list materializes an empty one without claiming any writer.

    expect(home).toContain(
      "profiles: Writable<Default<TrustedProfileList, []>>",
    );
  });

  it("mru rides Default<TrustedProfileMru, []> (wrapper-outside)", () => {
    // The empty default wraps the write contract, as it does for profiles.

    expect(home).toContain("mru: Writable<Default<TrustedProfileMru, []>>");
  });

  it("defaultProfile is optional (?) — the value-type-only assumption was wrong", () => {
    // The question token makes the generated field optional. Allowing an
    // undefined value alone still requires the field and prevents cold-start
    // repair from materializing a Home that has no default profile.

    expect(home).toContain("defaultProfile?: Writable<TrustedDefaultProfile>;");
  });

  it("Default is imported (the spellings above are inert without it)", () => {
    expect(home).toContain("Default");
    expect(home).toMatch(/from "commonfabric"/);
  });
});
