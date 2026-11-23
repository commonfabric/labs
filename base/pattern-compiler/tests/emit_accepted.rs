//! The `emit --accepted` command of the binary: an artifact for a program
//! in the subset, and the diagnostics with no artifact for another.

use std::path::PathBuf;
use std::process::{Command, Output};

/// Writes `source` as a module under `name` and runs `emit --accepted` on it.
fn emit_accepted(name: &str, source: &str) -> Output {
    let directory = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("emit_accepted");
    std::fs::create_dir_all(&directory).expect("the directory is made");
    std::fs::write(directory.join(name), source).expect("the module is written");
    Command::new(env!("CARGO_BIN_EXE_pattern-compiler"))
        .args(["emit", "--accepted", name])
        .current_dir(&directory)
        .output()
        .expect("the binary runs")
}

#[test]
fn prints_the_artifact_of_a_module_in_the_subset() {
    let output = emit_accepted(
        "accepted.tsx",
        r#"/// <cts-enable />
import { pattern } from "commonfabric";

export default pattern<{ title: string }>(({ title }) => {
  return { shown: title + "!" };
});
"#,
    );

    assert!(output.status.success());
    let modules: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("the output is JSON");
    assert_eq!(modules[0]["module"], "accepted.tsx");
    assert_eq!(modules[0]["patterns"][0]["name"], "default");
}

#[test]
fn prints_the_diagnostics_and_no_artifact_for_a_module_outside_the_subset() {
    let output = emit_accepted(
        "refused.tsx",
        r#"/// <cts-enable />
import { pattern } from "commonfabric";

export default pattern<{ title: string }>(({ title }) => {
  return { shown: title + String($h) };
});
"#,
    );

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let diagnostics = String::from_utf8_lossy(&output.stderr);
    assert!(
        diagnostics.contains("refused.tsx:5:34: error [stdlib:unsupported-member]"),
        "{diagnostics}"
    );
}
