import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { stub } from "@std/testing/mock";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { staticGitHubCredential } from "../github-auth.ts";
import { GITHUB_ORGANIZATION } from "../lib.ts";
import {
  gitEnvironment,
  OFFCUTS_CATCH_UP_FOR_MS,
  OFFCUTS_CATCH_UP_MS,
  OFFCUTS_JOB,
  OFFCUTS_ORGANIZATION,
  OFFCUTS_RETRY_MS,
  OFFCUTS_SWEEP_MS,
  OffcutsScan,
  parseGrepForTestingOnly,
  type ScanTarget,
} from "../offcuts-scan.ts";
import type { Job } from "../ci-jobs-page.ts";
import { commitFiles, git, makeRepository } from "./git-repos.ts";
import { FakeRelay, pushPayload } from "./webhook-relay.ts";

const ORG = GITHUB_ORGANIZATION.name;
const OFFCUTS = OFFCUTS_ORGANIZATION;
const CREDENTIAL = staticGitHubCredential("token");
const ENCODER = new TextEncoder();

describe("offcuts-scan", () => {
  // Each repository is a Git repository under `sources`, which the scan
  // fetches over `file:` URLs, so every fetch and search is Git's own.

  let root: string;

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "offcuts-scan-test-" });
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  const source = (name: string) => join(root, "sources", name);

  const commit = (name: string, files: Record<string, string | Uint8Array>) =>
    commitFiles(source(name), files);

  const target = (name: string): ScanTarget => ({ repo: `${ORG}/${name}` });

  /**
   * A scan of the repositories under `sources`, which takes the offcuts
   * organization's repositories from `offcuts`, and this organization's from
   * `ours`.
   */
  function scanner(
    relay: FakeRelay,
    offcuts: () => Promise<string[]> = () => Promise.resolve(["retired"]),
    ours: string[] = [],
  ): OffcutsScan {
    return new OffcutsScan({
      webhooks: relay.webhooks,
      directory: join(root, "scans"),
      remote: (repo) => toFileUrl(source(repo.split("/")[1])).href,
      repositoryNames: (organization) =>
        organization === OFFCUTS ? offcuts() : Promise.resolve(ours),
    });
  }

  /** Scans whichever of `targets` are due, and returns the rows after. */
  async function scanned(
    scan: OffcutsScan,
    targets: readonly ScanTarget[],
  ): Promise<Job[]> {
    scan.scan(targets, CREDENTIAL, () => {});
    await scan.scanning();
    return scan.jobs(targets);
  }

  const statuses = (jobs: readonly Job[]) =>
    Object.fromEntries(jobs.map((job) => [job.repo, job.status]));

  describe("OffcutsScan", () => {
    describe("instance members", () => {
      describe("scan()", () => {
        it("finds each form of reference, and passes over text that only resembles one", async () => {
          // `live` is a repository of both organizations, archived in this
          // one, so a path to it under this organization's name reaches this
          // organization's own. `loom` is what `cfs` was called before it was
          // renamed, so a path to `loom` reaches `cfs` wherever it is.

          await commit("positive", {
            url: `https://github.com/${OFFCUTS}/lib.git`,
            raw:
              `import "https://raw.githubusercontent.com/${OFFCUTS}/lib/main/mod.ts";`,
            action: `uses: ${OFFCUTS.toUpperCase()}/action@v1`,
            npm: `"lib": "${OFFCUTS}/lib"`,
            binary: new Uint8Array([0, ...ENCODER.encode(`${OFFCUTS}/lib`), 0]),
            ssh: `url = git@github.com:${ORG}/retired.git`,
            swift:
              `.package(url: "https://github.com/${ORG}/Retired", from: "1.0.0")`,
            sentence: `It moved to github.com/${ORG}/retired.`,
            wiki: `git clone https://github.com/${ORG}/retired.wiki.git`,
            renamed: `https://github.com/${ORG}/loom`,
          });
          await commit("negative", {
            prose: `The ${OFFCUTS} organization holds what was cut.`,
            scoped: `"@${ORG}/retired": "1.0.0"`,
            longer: `github.com/${ORG}/retired-two`,
            dotted: `github.com/${ORG}/retired.js`,
            prefixed: `github.com/not${ORG}/retired`,
            hyphenated: `github.com/not-${OFFCUTS}/lib`,
            underscored: `see under_${OFFCUTS}/lib`,
            root: `https://github.com/${OFFCUTS}/`,
            shared: `github.com/${ORG}/live`,
          });

          const jobs = await scanned(
            scanner(
              new FakeRelay(),
              () => Promise.resolve(["retired", "live", "cfs"]),
              ["live", "positive", "negative"],
            ),
            [target("positive"), target("negative")],
          );

          expect(
            jobs.map(({ repo, status, result }) => ({ repo, status, result })),
          )
            .toEqual([
              { repo: "positive", status: "bad", result: "10 references" },
              { repo: "negative", status: "good", result: "none" },
            ]);
        });

        it("scans a repository again when a push to its default branch is delivered, and not for another branch", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const scan = scanner(relay);
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          expect(statuses(await scanned(scan, [target("app")]))).toEqual({
            app: "bad",
          });
          await commit("app", { "deps.txt": "nothing" });

          await relay.deliver(
            "push",
            pushPayload(`${ORG}/app`, "refs/heads/feature"),
          );
          await scan.scanning();
          expect(statuses(scan.jobs([target("app")]))).toEqual({ app: "bad" });

          await relay.deliver(
            "push",
            pushPayload(`${ORG}/App`, "refs/heads/main"),
          );
          await scan.scanning();
          expect(statuses(scan.jobs([target("app")]))).toEqual({ app: "good" });
        });

        it("starts no scan, and so calls nothing back, when no repository is due", async () => {
          const scan = scanner(new FakeRelay());
          await commit("app", { "README.md": "nothing" });
          let calls = 0;
          scan.scan([target("app")], CREDENTIAL, () => calls++);
          await scan.scanning();

          scan.scan([target("app")], CREDENTIAL, () => calls++);
          await scan.scanning();

          expect(calls).toBe(1);
        });

        it("scans a repository again once its scan is OFFCUTS_SWEEP_MS old, and not before", async () => {
          const scan = scanner(new FakeRelay());
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          let now = Date.now();
          using _now = stub(Date, "now", () => now);
          await scanned(scan, [target("app")]);
          await commit("app", { "deps.txt": "nothing" });

          now += OFFCUTS_SWEEP_MS - 1;
          const before = await scanned(scan, [target("app")]);
          now += 1;
          const after = await scanned(scan, [target("app")]);

          expect([before, after].map(statuses)).toEqual([
            { app: "bad" },
            { app: "good" },
          ]);
        });

        it("scans every repository again when one is due and the offcuts organization's repositories have changed", async () => {
          const relay = new FakeRelay();
          await relay.open();
          let offcuts = ["retired"];
          const scan = scanner(relay, () => Promise.resolve(offcuts));
          await commit("app", {
            "go.mod": `require github.com/${ORG}/pond v1`,
          });
          await commit("web", { "README.md": "nothing" });
          const targets = [target("app"), target("web")];
          expect(statuses(await scanned(scan, targets))).toEqual({
            app: "good",
            web: "good",
          });
          await commit("web", { "deps.txt": `${OFFCUTS}/lib` });
          const pushToApp = async () => {
            await relay.deliver(
              "push",
              pushPayload(`${ORG}/app`, "refs/heads/main"),
            );
            await scan.scanning();
            return statuses(scan.jobs(targets));
          };

          expect(await pushToApp()).toEqual({ app: "good", web: "good" });
          offcuts = ["pond", "retired"];
          expect(await pushToApp()).toEqual({ app: "bad", web: "bad" });
        });

        it("fails the scans that were due when the offcuts organization's repositories cannot be listed", async () => {
          using errors = stub(console, "error");
          const scan = scanner(
            new FakeRelay(),
            () => Promise.reject(new Error("GitHub 503")),
          );
          await commit("app", { "README.md": "nothing" });

          const [job] = await scanned(scan, [target("app")]);

          expect(job).toMatchObject({ status: "warn", failing: false });
          expect(errors.calls.map((call) => call.args.join(" "))).toEqual([
            `offcuts: could not list the ` +
            `repositories of ${OFFCUTS} and ${ORG}: GitHub 503`,
          ]);
        });

        it("reports a repository it cannot fetch, and keeps a reference it found before", async () => {
          using errors = stub(console, "error");
          const scan = scanner(new FakeRelay());
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          await commit("web", { "README.md": "nothing" });
          const targets = [target("app"), target("web"), target("gone")];
          expect(statuses(await scanned(scan, targets))).toEqual({
            app: "bad",
            web: "good",
            gone: "warn",
          });

          await Deno.remove(join(root, "sources"), { recursive: true });
          const later = Date.now() + OFFCUTS_SWEEP_MS;
          using _now = stub(Date, "now", () => later);
          const jobs = await scanned(scan, targets);
          const kept = await Deno.stat(join(root, "scans", ORG, "web.git"))
            .then(
              () => true,
            );

          expect(statuses(jobs)).toEqual({
            app: "bad",
            web: "warn",
            gone: "warn",
          });
          expect(kept).toBe(true);
          expect(errors.calls.at(-1)?.args.join(" ")).toContain(
            `offcuts: could not scan ${ORG}/gone: \`git ls-remote\` exited`,
          );
        });

        it("scans a repository whose scan failed again once that scan is OFFCUTS_RETRY_MS old", async () => {
          using _errors = stub(console, "error");
          const scan = scanner(new FakeRelay());
          expect(statuses(await scanned(scan, [target("app")]))).toEqual({
            app: "warn",
          });
          await commit("app", { "README.md": "nothing" });

          expect(statuses(await scanned(scan, [target("app")]))).toEqual({
            app: "warn",
          });
          const later = Date.now() + OFFCUTS_RETRY_MS;
          using _now = stub(Date, "now", () => later);
          expect(statuses(await scanned(scan, [target("app")]))).toEqual({
            app: "good",
          });
        });

        it("finishes the scans of two scanners sharing a directory, started together", async () => {
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          await commit("web", { "README.md": "nothing" });
          const targets = [target("app"), target("web")];

          const both = await Promise.all([
            scanned(scanner(new FakeRelay()), targets),
            scanned(scanner(new FakeRelay()), targets),
          ]);

          expect(both.map(statuses)).toEqual([
            { app: "bad", web: "good" },
            { app: "bad", web: "good" },
          ]);
        });

        it("keeps the copies in a directory only its owner can read, even one that was readable by others", async () => {
          await Deno.mkdir(join(root, "scans"));
          await Deno.chmod(join(root, "scans"), 0o755);
          await commit("app", { "README.md": "nothing" });

          await scanned(scanner(new FakeRelay()), [target("app")]);

          expect((await Deno.stat(join(root, "scans"))).mode! & 0o777).toBe(
            0o700,
          );
        });

        it("refuses a directory that is a symbolic link", async () => {
          using errors = stub(console, "error");
          await Deno.mkdir(join(root, "elsewhere"));
          await Deno.symlink(join(root, "elsewhere"), join(root, "link"));
          await commit("app", { "README.md": "nothing" });
          const scan = new OffcutsScan({
            webhooks: new FakeRelay().webhooks,
            directory: join(root, "link"),
            remote: (repo) => toFileUrl(source(repo.split("/")[1])).href,
            repositoryNames: () => Promise.resolve([]),
          });

          const [job] = await scanned(scan, [target("app")]);

          expect(job.status).toBe("warn");
          expect(errors.calls[0].args.join(" ")).toContain(
            "is not a directory",
          );
        });

        it("reports every repository as unreadable, once, when the directory cannot be used", async () => {
          using errors = stub(console, "error");
          await Deno.writeTextFile(join(root, "file"), "");
          await commit("app", { "README.md": "nothing" });
          const scan = new OffcutsScan({
            webhooks: new FakeRelay().webhooks,
            directory: join(root, "file", "scans"),
            remote: (repo) => toFileUrl(source(repo.split("/")[1])).href,
            repositoryNames: () => Promise.resolve([]),
          });
          let calls = 0;

          scan.scan([target("app")], CREDENTIAL, () => calls++);
          await scan.scanning();
          scan.scan([target("app")], CREDENTIAL, () => calls++);
          await scan.scanning();

          expect(statuses(scan.jobs([target("app")]))).toEqual({ app: "warn" });
          expect(calls).toBe(1);
          expect(errors.calls.length).toBe(1);
          expect(errors.calls[0].args.join(" ")).toContain(
            `offcuts: could not use ${join(root, "file", "scans")}`,
          );
        });

        it("fetches a fresh copy of a repository after a scan of it fails", async () => {
          using _errors = stub(console, "error");
          const scan = scanner(new FakeRelay());
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          await scanned(scan, [target("app")]);
          await commit("app", { "deps.txt": "nothing" });
          // What a fetch that was stopped part way can leave behind.
          await Deno.writeTextFile(
            join(root, "scans", ORG, "app.git", "shallow.lock"),
            "",
          );

          let now = Date.now() + OFFCUTS_SWEEP_MS;
          using _now = stub(Date, "now", () => now);
          const failed = await scanned(scan, [target("app")]);
          now += OFFCUTS_SWEEP_MS;
          const recovered = await scanned(scan, [target("app")]);

          expect([failed, recovered].map(statuses)).toEqual([
            { app: "bad" },
            { app: "good" },
          ]);
          expect(failed[0].result).toBe("1 reference");
        });

        it("passes over a former name of a repository now in the offcuts organization once a repository of this one has it", async () => {
          await commit("app", {
            "go.mod": `require github.com/${ORG}/loom v1`,
          });

          const [taken] = await scanned(
            scanner(new FakeRelay(), () => Promise.resolve(["cfs"]), ["loom"]),
            [target("app")],
          );

          expect(taken.status).toBe("good");
        });

        for (
          const [shape, text] of [
            ["is not JSON", "not a record"],
            ["is not an object", "[]"],
            ["holds a time that is not a number", '{"x": "y"}'],
          ]
        ) {
          it(`starts a new record of failing repositories when the one there ${shape}`, async () => {
            using errors = stub(console, "error");
            await Deno.mkdir(join(root, "scans"), { recursive: true });
            await Deno.writeTextFile(
              join(root, "scans", "failing-since.json"),
              text,
            );
            await commit("app", { "deps.txt": `${OFFCUTS}/lib` });

            const [job] = await scanned(scanner(new FakeRelay()), [
              target("app"),
            ]);

            expect(job.status).toBe("bad");
            expect(errors.calls[0].args[0]).toBe(
              "offcuts: starting a new record of failing repositories:",
            );
          });
        }

        it("logs a callback that throws, and goes on scanning", async () => {
          using errors = stub(console, "error");
          const relay = new FakeRelay();
          await relay.open();
          const scan = scanner(relay);
          await commit("app", { "README.md": "nothing" });
          scan.scan([target("app")], CREDENTIAL, () => {
            throw new Error("tile gone");
          });
          await scan.scanning();

          await relay.deliver(
            "push",
            pushPayload(
              `${ORG}/app`,
              "refs/heads/main",
              await commit("app", { "deps.txt": `${OFFCUTS}/lib` }),
            ),
          );
          await scan.scanning();

          expect(errors.calls[0].args.join(" ")).toBe(
            "offcuts: telling the tile about a scan failed: tile gone",
          );
          expect(statuses(scan.jobs([target("app")]))).toEqual({ app: "bad" });
        });

        it("scans a repository a push was delivered for once it is first asked to scan", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const scan = scanner(relay);
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });

          await relay.deliver(
            "push",
            pushPayload(`${ORG}/app`, "refs/heads/main"),
          );
          await scan.scanning();
          const before = scan.jobs([target("app")]);
          const after = await scanned(scan, [target("app")]);

          expect([before, after].map(statuses)).toEqual([
            { app: "unknown" },
            { app: "bad" },
          ]);
        });

        it("forgets a repository that is no longer scanned once every repository is scanned again", async () => {
          // A repository is scanned again on its own once its scan is
          // OFFCUTS_SWEEP_MS old, and every repository is scanned again when
          // the offcuts organization's repositories change.

          let offcuts = ["retired"];
          let now = Date.now();
          using _now = stub(Date, "now", () => now);
          const scan = scanner(new FakeRelay(), () => Promise.resolve(offcuts));
          await commit("app", { "README.md": "nothing" });
          await commit("web", { "deps.txt": `${OFFCUTS}/lib` });
          const [, first] = await scanned(scan, [target("app"), target("web")]);
          const copy = join(root, "scans", ORG, "web.git");
          const kept = await Deno.stat(copy).then(() => true);

          offcuts = ["pond", "retired"];
          now += OFFCUTS_SWEEP_MS;
          await scanned(scan, [target("app")]);
          const gone = await Deno.stat(copy).then(() => false, () => true);
          offcuts = ["pond", "retired", "rock"];
          now += OFFCUTS_SWEEP_MS;
          const [, again] = await scanned(scan, [target("app"), target("web")]);

          expect({ kept, gone }).toEqual({ kept: true, gone: true });
          expect(again.status).toBe("bad");
          expect(again.startedAt).not.toBe(first.startedAt);
        });

        it("scans a repository again until it has read the commit a delivered push named, and then stops", async () => {
          const relay = new FakeRelay();
          await relay.open();
          let listings = 0;
          const scan = scanner(relay, () => {
            listings++;
            return Promise.resolve(["retired"]);
          });
          await commit("app", { "README.md": "nothing" });
          let now = Date.now();
          using _now = stub(Date, "now", () => now);
          await scanned(scan, [target("app")]);
          // The push names a commit the branch does not yet show, as GitHub can for
          // a moment after a push.
          await git(source("app"), ["switch", "--quiet", "--create", "next"]);
          const pushed = await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          await git(source("app"), ["switch", "--quiet", "main"]);

          await relay.deliver(
            "push",
            pushPayload(`${ORG}/app`, "refs/heads/main", pushed),
          );
          await scan.scanning();
          const behind = scan.jobs([target("app")]);
          await git(source("app"), ["update-ref", "refs/heads/main", pushed]);
          now += OFFCUTS_CATCH_UP_MS - 1;
          const tooSoon = await scanned(scan, [target("app")]);
          now += 1;
          const caughtUp = await scanned(scan, [target("app")]);
          const scans = listings;
          now += OFFCUTS_CATCH_UP_MS;
          await scanned(scan, [target("app")]);

          expect([behind, tooSoon, caughtUp].map(statuses)).toEqual([
            { app: "good" },
            { app: "good" },
            { app: "bad" },
          ]);
          expect(listings).toBe(scans);
        });

        it("calls back after a scan only when a row changed", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const scan = scanner(relay);
          const head = await commit("app", { "README.md": "nothing" });
          let calls = 0;
          scan.scan([target("app")], CREDENTIAL, () => calls++);
          await scan.scanning();
          const push = async (after: string) => {
            await relay.deliver(
              "push",
              pushPayload(`${ORG}/app`, "refs/heads/main", after),
            );
            await scan.scanning();
            return calls;
          };

          const unchanged = await push(head);
          const changed = await push(
            await commit("app", { "deps.txt": `${OFFCUTS}/lib` }),
          );

          expect({ unchanged, changed }).toEqual({ unchanged: 1, changed: 2 });
        });

        it("stops scanning for a delivered push OFFCUTS_CATCH_UP_FOR_MS after it when no scan reads its commit", async () => {
          const relay = new FakeRelay();
          await relay.open();
          let listings = 0;
          const scan = scanner(relay, () => {
            listings++;
            return Promise.resolve(["retired"]);
          });
          await commit("app", { "README.md": "nothing" });
          let now = Date.now();
          using _now = stub(Date, "now", () => now);
          await scanned(scan, [target("app")]);
          await git(source("app"), ["switch", "--quiet", "--create", "next"]);
          const never = await commit("app", { "a.txt": "a" });
          await git(source("app"), ["switch", "--quiet", "main"]);

          const pushedAt = now;
          await relay.deliver(
            "push",
            pushPayload(`${ORG}/app`, "refs/heads/main", never),
          );
          await scan.scanning();
          const afterPush = listings;
          now = pushedAt + OFFCUTS_CATCH_UP_FOR_MS - 1;
          await scanned(scan, [target("app")]);
          const within = listings;
          // Long enough after the last scan that only the end of the window stops
          // another.
          now += OFFCUTS_CATCH_UP_MS;
          await scanned(scan, [target("app")]);

          expect({ afterPush, within, after: listings }).toEqual({
            afterPush: 2,
            within: 3,
            after: 3,
          });
        });

        it("follows the latest of two delivered pushes until a scan reads its commit", async () => {
          // Each push is scanned while GitHub still shows the commit before it.

          const relay = new FakeRelay();
          await relay.open();
          const scan = scanner(relay);
          await commit("app", { "README.md": "nothing" });
          let now = Date.now();
          using _now = stub(Date, "now", () => now);
          await scanned(scan, [target("app")]);
          await git(source("app"), ["switch", "--quiet", "--create", "next"]);
          const second = await commit("app", { "README.md": "still nothing" });
          const third = await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          await git(source("app"), ["switch", "--quiet", "main"]);
          const push = async (after: string) => {
            await relay.deliver(
              "push",
              pushPayload(`${ORG}/app`, "refs/heads/main", after),
            );
            await scan.scanning();
          };

          await push(second);
          await git(source("app"), ["update-ref", "refs/heads/main", second]);
          await push(third);
          await git(source("app"), ["update-ref", "refs/heads/main", third]);
          now += OFFCUTS_CATCH_UP_MS;
          const [job] = await scanned(scan, [target("app")]);

          expect(job.status).toBe("bad");
        });

        it("searches a copy again without fetching it when the branch has not moved", async () => {
          using errors = stub(console, "error");
          const scan = scanner(new FakeRelay());
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          await scanned(scan, [target("app")]);
          // A fetch into this copy would fail on the lock.
          await Deno.writeTextFile(
            join(root, "scans", ORG, "app.git", "shallow.lock"),
            "",
          );

          const later = Date.now() + OFFCUTS_SWEEP_MS;
          using _now = stub(Date, "now", () => later);
          const [job] = await scanned(scan, [target("app")]);

          expect(job.status).toBe("bad");
          expect(errors.calls.length).toBe(0);
        });

        it("runs Git without the configuration of a repository the directory is in", async () => {
          // The enclosing repository's configuration rewrites every `file:` URL to
          // one that names nothing.

          await git(root, ["init", "--quiet"]);
          await git(root, [
            "config",
            "url.file:///nowhere/.insteadOf",
            "file:///",
          ]);
          await commit("app", { "README.md": "nothing" });

          const [job] = await scanned(scanner(new FakeRelay()), [
            target("app"),
          ]);

          expect(job.status).toBe("good");
        });

        it("runs Git without the dashboard's own environment", async () => {
          // A `GIT_ALLOW_PROTOCOL` that reached Git would refuse the `file:`
          // URLs these repositories are fetched from.

          await commit("app", { "README.md": "nothing" });
          const previous = Deno.env.get("GIT_ALLOW_PROTOCOL");
          Deno.env.set("GIT_ALLOW_PROTOCOL", "https");
          try {
            const [job] = await scanned(scanner(new FakeRelay()), [
              target("app"),
            ]);

            expect(job.status).toBe("good");
          } finally {
            if (previous === undefined) Deno.env.delete("GIT_ALLOW_PROTOCOL");
            else Deno.env.set("GIT_ALLOW_PROTOCOL", previous);
          }
        });

        it("scans the default branch whatever it is called", async () => {
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          await git(source("app"), ["branch", "--move", "main", "trunk"]);

          const [job] = await scanned(scanner(new FakeRelay()), [
            target("app"),
          ]);

          expect(job.status).toBe("bad");
        });

        it("finds no references in a repository whose default branch has no commits", async () => {
          await makeRepository(source("app"));

          const [job] = await scanned(scanner(new FakeRelay()), [
            target("app"),
          ]);

          expect(job).toMatchObject({
            status: "good",
            result: "none",
            href: `https://github.com/${ORG}/app`,
          });
        });

        it("finds a reference in a file whose name holds a newline", async () => {
          const commit_ = await commit("app", {
            "a\nb.txt": `${OFFCUTS}/lib`,
            "c.txt": `x\n${OFFCUTS}/lib`,
          });

          const [job] = await scanned(scanner(new FakeRelay()), [
            target("app"),
          ]);

          expect(job).toMatchObject({
            status: "bad",
            result: "2 references",
            href: `https://github.com/${ORG}/app/blob/${commit_}/a%0Ab.txt#L1`,
          });
        });
      });

      describe("jobs()", () => {
        it("returns a gray row for a repository not yet scanned", () => {
          const [job] = scanner(new FakeRelay()).jobs([target("app")]);

          expect(job).toEqual({
            repo: "app",
            workflow: OFFCUTS_JOB,
            path: "",
            pinned: false,
            status: "unknown",
            failing: false,
            result: "not scanned yet",
            startedAt: undefined,
            ranMs: undefined,
            href: `https://github.com/${ORG}/app`,
          });
        });

        it("returns a red row counting the lines that reference the offcuts organization, linked to the first, and a green one linked to the commit", async () => {
          const dirty = await commit("app", {
            "a.txt": "nothing",
            "b/c d.txt":
              `one\ntwo\n${OFFCUTS}/lib,${OFFCUTS}/other\n${OFFCUTS}/x`,
          });
          const clean = await commit("web", { "a.txt": "nothing" });

          const [bad, good] = await scanned(scanner(new FakeRelay()), [
            target("app"),
            target("web"),
          ]);

          expect(bad).toMatchObject({
            status: "bad",
            failing: true,
            result: "2 references",
            href: `https://github.com/${ORG}/app/blob/${dirty}/b/c%20d.txt#L3`,
          });
          expect(good).toMatchObject({
            status: "good",
            failing: false,
            result: "none",
            href: `https://github.com/${ORG}/web/tree/${clean}`,
          });
          expect(good.startedAt).toBeGreaterThan(0);
        });

        it("dates a red row from the first scan that found references, and a green one from its latest scan", async () => {
          const scan = scanner(new FakeRelay());
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          await commit("web", { "README.md": "nothing" });
          const targets = [target("app"), target("web")];
          const [first] = await scanned(scan, targets);

          const later = Date.now() + OFFCUTS_SWEEP_MS;
          using _now = stub(Date, "now", () => later);
          const [bad, good] = await scanned(scan, targets);

          expect(bad.startedAt).toBe(first.startedAt);
          expect(good.startedAt).toBe(later);
        });

        it("dates a red row from the first scan that found references made by an earlier scanner sharing the directory", async () => {
          await commit("app", { "deps.txt": `${OFFCUTS}/lib` });
          const [first] = await scanned(scanner(new FakeRelay()), [
            target("app"),
          ]);

          const later = Date.now() + OFFCUTS_SWEEP_MS;
          using _now = stub(Date, "now", () => later);
          const [again] = await scanned(scanner(new FakeRelay()), [
            target("app"),
          ]);

          expect(again.status).toBe("bad");
          expect(again.startedAt).toBe(first.startedAt);
        });
      });
    });
  });

  describe("gitEnvironment()", () => {
    it("sends the token to GitHub and to no other host", async () => {
      const env = gitEnvironment("secret", join(root, "scans"));
      const header = async (url: string) => {
        const { code, stdout } = await new Deno.Command("git", {
          args: ["config", "--get-urlmatch", "http.extraHeader", url],
          env,
          cwd: root,
        }).output();
        return { code, header: new TextDecoder().decode(stdout).trim() };
      };

      expect(await header("https://github.com/o/r.git")).toEqual({
        code: 0,
        header: `Authorization: Basic ${btoa("x-access-token:secret")}`,
      });
      expect(await header("https://example.com/o/r.git")).toEqual({
        code: 1,
        header: "",
      });
    });
  });

  describe("parseGrepForTestingOnly()", () => {
    const tree = "refs/heads/scanned";
    const match = (path: string, line: string, text: string) =>
      `${tree}:${path}\0${line}\0${text}\n`;
    const refusal = (rest: string) =>
      `Unexpected \`git grep\` output: ${JSON.stringify(rest)}`;
    // Each case follows one well-formed match, so the message has to quote
    // the output from the malformed match on, not from the start.
    const first = match("deps.txt", "1", `${OFFCUTS}/a`);

    it("returns one reference per line, however many matches that line holds", () => {
      const output = match("deps.txt", "3", `${OFFCUTS}/a`) +
        match("deps.txt", "3", `${OFFCUTS}/b`) +
        match("deps.txt", "4", `${OFFCUTS}/a`) +
        match("odd\nname.md", "3", `${OFFCUTS}/a`);

      expect(parseGrepForTestingOnly(output)).toEqual([
        { path: "deps.txt", line: 3 },
        { path: "deps.txt", line: 4 },
        { path: "odd\nname.md", line: 3 },
      ]);
    });

    it("throws, quoting the rest of the output, on a match outside the scanned tree", () => {
      const rest = `refs/heads/other:deps.txt\x003\0${OFFCUTS}/a\n`;

      expect(() => parseGrepForTestingOnly(first + rest)).toThrow(
        refusal(rest),
      );
    });

    it("throws, quoting the rest of the output, on a line number that is not an integer", () => {
      const rest = match("deps.txt", "3.5", `${OFFCUTS}/a`);

      expect(() => parseGrepForTestingOnly(first + rest)).toThrow(
        refusal(rest),
      );
    });

    it("throws, quoting the rest of the output, on a match with no separator after its line number", () => {
      const rest = `${tree}:deps.txt\x003 ${OFFCUTS}/a\n`;

      expect(() => parseGrepForTestingOnly(first + rest)).toThrow(
        refusal(rest),
      );
    });

    it("throws, quoting the rest of the output, on output that ends before a match's newline", () => {
      const rest = `${tree}:deps.txt\x003\0${OFFCUTS}/a`;

      expect(() => parseGrepForTestingOnly(first + rest)).toThrow(
        refusal(rest),
      );
    });
  });
});
