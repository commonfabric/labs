//! The `emit` command of the binary: an artifact for a program in the
//! subset, and the diagnostics with no artifact for another. With
//! `--unchecked` it prints the artifact of a refused module too, for
//! diagnosis.

use std::path::PathBuf;
use std::process::{Command, Output};

/// Writes `source` as a module under `name` and runs `emit` on it with
/// `flags`.
fn emit(flags: &[&str], name: &str, source: &str) -> Output {
    let directory = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("emit_accepted");
    std::fs::create_dir_all(&directory).expect("the directory is made");
    std::fs::write(directory.join(name), source).expect("the module is written");
    Command::new(env!("CARGO_BIN_EXE_pattern-compiler"))
        .arg("emit")
        .args(flags)
        .arg(name)
        .current_dir(&directory)
        .output()
        .expect("the binary runs")
}

/// Runs `emit --accepted`, the form the runtime's compile on load uses.
fn emit_accepted(name: &str, source: &str) -> Output {
    emit(&["--accepted"], name, source)
}

/// A module the check refuses: its body names the host of a call.
const REFUSED: &str = r#"/// <cts-enable />
import { pattern } from "commonfabric";

export default pattern<{ title: string }>(({ title }) => {
  return { shown: title + String($h) };
});
"#;

#[test]
fn prints_no_artifact_for_a_refused_module_where_no_flag_is_given() {
    let output = emit(&[], "refused-plain.tsx", REFUSED);

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let diagnostics = String::from_utf8_lossy(&output.stderr);
    assert!(
        diagnostics.contains("refused-plain.tsx:5:34: error [stdlib:unsupported-member]"),
        "{diagnostics}"
    );
}

#[test]
fn prints_the_artifact_of_a_refused_module_with_the_flag_for_diagnosis() {
    let output = emit(&["--unchecked"], "refused-unchecked.tsx", REFUSED);

    assert!(output.status.success());
    let modules: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("the output is JSON");
    assert_eq!(modules[0]["module"], "refused-unchecked.tsx");
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
