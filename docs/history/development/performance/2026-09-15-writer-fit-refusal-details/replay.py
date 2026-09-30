"""Replay the frozen writer-fit experiment in a new disposable Git worktree.

Usage: python3 replay.py /absolute/new/worktree --rounds 5 --profiles 3
Requires Git, Python 3, and the repository's Deno version. Leaves all evidence
and the worktree in place. It never changes the invoking checkout.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def records(log, prefix):
    return [json.loads(line[len(prefix):]) for line in log.splitlines()
            if line.startswith(prefix)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--profiles", type=int, default=3)
    args = parser.parse_args()
    bundle = json.loads(Path(__file__).with_name("replay-inputs.json").read_text(encoding="utf-8"))
    fixture_path = "packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx"
    fixture_digest = hashlib.sha256(bundle["files"][fixture_path].encode("utf-8")).hexdigest()
    require(fixture_digest == bundle["fixtureSha256"], "Frozen shared fixture checksum differs")
    require(args.rounds >= 0 and args.profiles >= 0, "Round counts must be nonnegative")
    checkout = args.destination.resolve()
    repository = subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], encoding="utf-8").strip()
    run("git", "worktree", "add", "--detach", str(checkout), bundle["base"],
        cwd=repository)

    def apply(key, reverse=False):
        command = ["git", "apply"] + (["--reverse"] if reverse else [])
        subprocess.run(command, input=bundle[key], encoding="utf-8", cwd=checkout,
                       check=True)

    apply("instrumentationPatch")
    apply("harnessPatch")
    for name, text in bundle["files"].items():
        path = checkout / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    shutil.copyfile(checkout / "packages/cli/lib/test-runner.ts",
                    checkout / "packages/cli/lib/writer-fit-strict-runner.ts")
    apply("strictHarnessPatch")
    output = checkout / "writer-fit-results"
    output.mkdir()
    results = []
    optimized = False

    def select(arm):
        nonlocal optimized
        if optimized != (arm == "after"):
            apply("optimizationPatch", reverse=optimized)
            optimized = arm == "after"

    def execute(name, strict=False, profile=False):
        env = dict(os.environ, EXPERIMENTAL_SERVER_EXECUTION="false",
                   WRITER_FIT_MODE="enforce-strict" if strict else "enforce-explicit",
                   WRITER_FIT_PROFILE="1" if profile else "0",
                   WRITER_FIT_OUT=str(output / name))
        driver = ".writer-fit-strict-run.ts" if strict else ".writer-fit-run.ts"
        with (output / (name + ".log")).open("w", encoding="utf-8") as stream:
            run("deno", "run", "-A", "--no-check", "--frozen", driver,
                cwd=checkout, env=env, stdout=stream, stderr=subprocess.STDOUT)
        return (output / (name + ".log")).read_text(encoding="utf-8")

    for profile, count in [(False, args.rounds), (True, args.profiles)]:
        for repetition in range(1, count + 1):
            for arm in (["before", "after"] if repetition % 2 else ["after", "before"]):
                select(arm)
                name = f'{"profile" if profile else "timing"}-{repetition}-{arm}'
                load = os.getloadavg()
                log = execute(name, profile=profile)
                result, = records(log, "WRITER_FIT_RESULT ")
                require(
                    not result.get("error") and not result["runtimeErrors"],
                    'Successful arm reported runtime errors',
                )
                require(
                    not result["consoleErrors"],
                    'Successful arm reported console errors',
                )
                require(
                    len(result["results"]) == 6,
                    'Expected six assertions',
                )
                require(
                    all(row["passed"] for row in result["results"]),
                    'A successful-arm assertion failed',
                )
                actions = records(log, "WRITER_FIT_ACTION ")
                renders = records(log, "WRITER_FIT_RENDER ")
                for index, n in enumerate([11, 50, 150]):
                    action = next(row for row in actions
                                  if row["actionName"] == f"action_{3 + index * 2}")
                    delta = {key: action["after"][key] - action["before"][key]
                             for key in ["cfcPreparedTx", "cfcPrepareRejects",
                                         "refusalDetailsRecorded", "consumedLabelWalks",
                                         "dereferenceTracesRecorded"]}
                    require(
                        delta["refusalDetailsRecorded"] == (n + 1 if arm == "before" else 0),
                        'Unexpected successful-arm detail count',
                    )
                    require(
                        delta["consumedLabelWalks"] == (1 if arm == "before" else 0),
                        'Unexpected successful-arm label-walk count',
                    )
                    require(
                        delta["cfcPreparedTx"] == 1 and delta["cfcPrepareRejects"] == 0,
                        'Expected one prepared commit and no rejection',
                    )
                    query = result["results"][index * 2]["durationMs"]
                    assertion = result["results"][index * 2 + 1]["durationMs"]
                    render = renders[index]["renderMs"]
                    results.append(dict(name=name, arm=arm, repetition=repetition,
                                        profile=profile, n=n, copyMs=action["actionMs"],
                                        renderMs=render, queryMs=query, assertionMs=assertion,
                                        groupMs=action["actionMs"] + render + query + assertion,
                                        delta=delta, loadStart=load, loadEnd=os.getloadavg()))
                (output / "raw.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
                print(name, "passed", flush=True)

    apply("strictInstrumentationPatch")
    strict_results = []
    for arm in ["before", "after"]:
        select(arm)
        log = execute("strict-" + arm, strict=True)
        result, = records(log, "WRITER_FIT_RESULT ")
        require(
            [row["passed"] for row in result["results"]] == [True, False] * 3,
            'Expected passing queries and refused copies',
        )
        refusals = records(log, "WRITER_FIT_REFUSAL ")
        require(
            len(refusals) == 3,
            'Expected three strict prepare refusals',
        )
        actions = records(log, "WRITER_FIT_ACTION ")
        for index, n in enumerate([11, 50, 150]):
            refusal = refusals[index]
            require(
                len(refusal["refusals"]) == n + 1,
                'Unexpected strict refusal-detail count',
            )
            for detail in refusal["refusals"]:
                require(
                    detail["gate"] == "writer-fit",
                    'Unexpected refusal gate',
                )
                require(
                    detail["attribution"] == "complete" and detail["inputs"],
                    'Strict refusal lost full input attribution',
                )
                require(
                    '"fixture-private"' in detail["offendingAtoms"],
                    'Strict refusal omitted the source atom',
                )
                require(
                    detail["reason"] in refusal["reasons"],
                    'Refusal detail has no matching reason',
                )
                target = detail["target"]
                expected = (f'writer-fit confidentiality misfit for {target["id"]} '
                            f'at /{"/".join(target["path"])} (canWrite, §8.12.4): '
                            + ", ".join(detail["offendingAtoms"]))
                require(
                    detail["reason"] == expected,
                    'Strict refusal reason text changed',
                )
            action = next(row for row in actions if row["actionName"] == f"action_{3 + index * 2}")
            delta = {key: action["after"][key] - action["before"][key]
                     for key in ["refusalDetailsRecorded", "consumedLabelWalks",
                                 "cfcPrepareRejects", "cfcPreparedTx"]}
            require(
                delta == dict(refusalDetailsRecorded=n + 1, consumedLabelWalks=1,
                                 cfcPrepareRejects=1, cfcPreparedTx=0),
                'Unexpected strict preparation counters',
            )
            example = refusal["refusals"][0]
            strict_results.append(dict(
                arm=arm, n=n, delta=delta, reason=example["reason"],
                offendingAtoms=example["offendingAtoms"], attribution=example["attribution"],
                inputCount=len(example["inputs"]), firstInput=example["inputs"][0]))
        print("strict-" + arm, "passed", flush=True)
    (output / "strict.json").write_text(json.dumps(strict_results, indent=2) + "\n", encoding="utf-8")
    print("Evidence:", output)


if __name__ == "__main__":
    main()
