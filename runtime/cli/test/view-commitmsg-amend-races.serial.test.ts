import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { realGit } from "../lib/view/commitmsg.ts";
import {
  git,
  initRepository,
  installHook,
  revParse,
  shellQuote,
  supportsReftable,
  unreferencedCommit,
  withGitShim,
} from "./view-commitmsg-test-helpers.ts";

const reftableSupported = await supportsReftable();

/** A Git shim body that runs `script` just before realGit computes the branch's
 * lock path, after `git commit` has published the amended commit. */
const beforeLocking = (script: string): string =>
  `if test "$1" = rev-parse && test "$3" = --git-path && test "$4" = refs/heads/main; then
  amended=$(git rev-parse refs/heads/main)
  action=$(tail -n 1 .git/logs/refs/heads/main | cut -f2 | cut -d: -f1)
  ${script}
fi`;

const CHANGED = /^HEAD changed during the amend; no commit was amended\.$/;
const ROLLBACK_REFUSED =
  /^HEAD changed during the amend; no commit was amended\.; rollback failed: /;

describe({
  name: "view-commitmsg-amend-races",
  ignore: Deno.build.os === "windows",
  fn: () => {
    let root = "";

    beforeEach(async () => {
      root = await Deno.makeTempDir();
    });

    afterEach(async () => {
      await Deno.remove(root, { recursive: true });
    });

    /**
     * Amends in a repository of `storage` with every reflog read refused,
     * and checks that the commit Git's summary names is published.
     */
    async function amendWithoutReflogs(
      storage: "files" | "reftable",
    ): Promise<void> {
      const repository = `${root}/repository`;
      await Deno.mkdir(repository);
      expect(await initRepository(repository, storage)).toBe(true);
      const head = await revParse(repository, "HEAD");
      await installHook(
        repository,
        "reference-transaction",
        `if test "\${1-}" = committed; then
  rm -f "$(dirname "$GIT_INDEX_FILE")/reference-transactions"
fi`,
      );

      // The shim records each reflog read it refuses.
      const refused = `${root}/refused`;
      await Deno.writeTextFile(refused, "");
      const result = await withGitShim(
        `if test "$1" = rev-parse && test "$3" = --git-path; then
  case "$4" in logs/*) echo "$4" >> ${shellQuote(refused)}; exit 1 ;; esac
fi
if test "$1" = reflog && test "$2" = show && test "$3" != --all; then
  echo "reflog show $3" >> ${shellQuote(refused)}
  exit 1
fi`,
        () => realGit(repository).amendCommit("amended", new Map(), head),
      );

      expect((await Deno.readTextFile(refused)).split("\n")).toContain(
        storage === "files"
          ? "logs/refs/heads/main"
          : "reflog show refs/heads/main",
      );
      expect(result.head).not.toBe(head);
      expect(await revParse(repository, "HEAD")).toBe(result.head);
      expect(await git(repository, ["log", "-1", "--format=%s"])).toBe(
        "amended\n",
      );
    }

    it("publishes the commit Git's summary names when no reflog of a files repository can be read", async () => {
      await amendWithoutReflogs("files");
    });

    it({
      name:
        "publishes the commit Git's summary names when no reflog of a reftable repository can be read",
      ignore: !reftableSupported,
      fn: () => amendWithoutReflogs("reftable"),
    });

    it("restores the original commit after a hook moves the amended branch", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      const other = await unreferencedCommit(root);
      await installHook(
        root,
        "post-commit",
        `git update-ref refs/heads/main ${other}`,
      );

      expect(() => realGit(root).amendCommit("amended", new Map(), head))
        .toThrow(CHANGED);
      expect(await revParse(root, "refs/heads/main")).toBe(head);
    });

    it("restores the original commit after a marked move made once Git finished", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      const other = await unreferencedCommit(root);

      await withGitShim(
        beforeLocking(
          `git update-ref -m "$action: race" refs/heads/main ${other} "$amended"`,
        ),
        () =>
          expect(() => realGit(root).amendCommit("amended", new Map(), head))
            .toThrow(CHANGED),
      );

      expect(await revParse(root, "refs/heads/main")).toBe(head);
    });

    it("restores the original commit when a racer puts back the commit a hook moved away from", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      const other = await unreferencedCommit(root);
      const amendedFile = `${root}/.git/amended-commit`;
      await installHook(
        root,
        "post-commit",
        `git rev-parse HEAD > ${shellQuote(amendedFile)}
git update-ref -m "$GIT_REFLOG_ACTION: hook" refs/heads/main ${other}`,
      );

      await withGitShim(
        beforeLocking(
          `git update-ref refs/heads/main "$(cat ${
            shellQuote(amendedFile)
          })" ${other}`,
        ),
        () =>
          expect(() => realGit(root).amendCommit("amended", new Map(), head))
            .toThrow(CHANGED),
      );

      expect(await revParse(root, "refs/heads/main")).toBe(head);
    });

    it("keeps an unmarked move made once Git finished", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      const other = await unreferencedCommit(root);

      await withGitShim(
        beforeLocking(
          `git update-ref -m race refs/heads/main ${other} "$amended"`,
        ),
        () =>
          expect(() => realGit(root).amendCommit("amended", new Map(), head))
            .toThrow(ROLLBACK_REFUSED),
      );

      expect(await revParse(root, "refs/heads/main")).toBe(other);
    });

    it("keeps a marked move that does not continue from the amended commit", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      const other = await unreferencedCommit(root);

      await withGitShim(
        beforeLocking(
          `printf '%s\\n' ${head} > .git/refs/heads/main
git update-ref -m "$action: race" refs/heads/main ${other}`,
        ),
        () =>
          expect(() => realGit(root).amendCommit("amended", new Map(), head))
            .toThrow(ROLLBACK_REFUSED),
      );

      expect(await revParse(root, "refs/heads/main")).toBe(other);
    });

    it("restores the branch when HEAD is switched behind Git's locks", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      await git(root, ["branch", "topic"]);

      await withGitShim(
        `if test "$1" = rev-parse; then
  case "$2" in *'^{tree}') printf 'ref: refs/heads/topic\\n' > .git/HEAD ;; esac
fi`,
        () =>
          expect(() => realGit(root).amendCommit("amended", new Map(), head))
            .toThrow(
              /^HEAD changed before the amend completed; no commit was amended\.$/,
            ),
      );

      expect(await git(root, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/topic\n",
      );
      expect(await revParse(root, "refs/heads/main")).toBe(head);
    });
  },
});
