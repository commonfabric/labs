//! The command-line entry of the prototype front end.

use std::path::Path;
use std::process::ExitCode;

use pattern_compiler::program::{analyze, ProgramAnalysis, SourceFile};
use pattern_compiler::report::Report;
use pattern_compiler::{catalog, corpus};

const USAGE: &str = "\
usage: pattern-compiler <command>

commands:
  catalog
      Print each entry of the diagnostics catalog with its status.
  check <file>...
      Check the given modules as one program and print their diagnostics.
      With --hints, print hints as well.
  corpus <patterns directory> [--json] [--files] [--diagnostics]
      Check the pattern corpus and print the report. With --json, print the
      report as JSON. With --files, print the corpus's file list instead.
      With --diagnostics, print every error and warning instead.
  bodies <file>...
      Print the bodies of the given modules as JSON.
  types <file>...
      Print, for the given modules, how many written types were evaluated,
      how many receivers and collections have a declared type, and each
      overload signature with the declared type that replaces it. With
      --only=<text>, print for the modules whose path contains the text; the
      other modules are still read, so that imports between them resolve.
      With --show=<text>, list the receivers that have no type for a reason
      whose description contains the text.
";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let (flags, operands): (Vec<&str>, Vec<&str>) = arguments
        .iter()
        .skip(1)
        .map(String::as_str)
        .partition(|argument| argument.starts_with("--"));
    let result = match arguments.first().map(String::as_str) {
        Some("catalog") => {
            print!("{}", catalog::render());
            Ok(true)
        }
        Some("check") if !operands.is_empty() => check(&operands, flags.contains(&"--hints")),
        Some("bodies") if !operands.is_empty() => bodies(&operands),
        Some("types") if !operands.is_empty() => types(&operands, &flags),
        Some("corpus") if operands.len() == 1 => corpus_report(operands[0], &flags),
        _ => {
            eprint!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(error) => {
            eprintln!("pattern-compiler: {error}");
            ExitCode::from(2)
        }
    }
}

fn read(paths: &[&str]) -> std::io::Result<Vec<SourceFile>> {
    paths
        .iter()
        .map(|path| {
            Ok(SourceFile {
                path: path.replace('\\', "/"),
                text: std::fs::read_to_string(path)?,
            })
        })
        .collect()
}

/// Prints the parse failures of an analysis and returns whether it has none.
fn parsed(analysis: &ProgramAnalysis) -> bool {
    for failure in &analysis.failures {
        eprintln!("{}: the module does not parse", failure.path);
        for error in &failure.errors {
            eprintln!("  {error}");
        }
    }
    analysis.failures.is_empty()
}

fn check(paths: &[&str], hints: bool) -> std::io::Result<bool> {
    let analysis = analyze(&read(paths)?);
    let mut accepted = parsed(&analysis);
    for module in &analysis.modules {
        accepted &= module.accepted();
        for diagnostic in &module.diagnostics {
            if hints || diagnostic.severity != pattern_compiler::diagnostics::Severity::Hint {
                println!("{diagnostic}");
            }
        }
    }
    Ok(accepted)
}

fn bodies(paths: &[&str]) -> std::io::Result<bool> {
    let analysis = analyze(&read(paths)?);
    let modules: Vec<_> = analysis
        .modules
        .iter()
        .map(|module| serde_json::json!({ "path": module.path, "bodies": module.bodies }))
        .collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&modules).map_err(std::io::Error::other)?
    );
    Ok(parsed(&analysis))
}

fn types(paths: &[&str], flags: &[&str]) -> std::io::Result<bool> {
    let mut analysis = analyze(&read(paths)?);
    if let Some(only) = flags.iter().find_map(|flag| flag.strip_prefix("--only=")) {
        analysis.modules.retain(|module| module.path.contains(only));
    }
    let mut counts = std::collections::BTreeMap::new();
    for module in &analysis.modules {
        for (key, count) in &module.counts {
            if key.starts_with("types:") {
                *counts.entry(key.as_str()).or_insert(0) += count;
            }
        }
    }
    for (key, count) in counts {
        println!("{count:6}  {key}");
    }
    if let Some(show) = flags.iter().find_map(|flag| flag.strip_prefix("--show=")) {
        for module in &analysis.modules {
            for (label, line, text) in &module.untyped {
                if label.contains(show) {
                    println!("{}:{line}: {text}", module.path);
                }
            }
        }
    }
    for module in &analysis.modules {
        for overload in &module.overloads {
            println!();
            println!("{}:{}: {}", module.path, overload.line, overload.name);
            println!("  parameters: {}", overload.parameters.join(", "));
            println!("  result:     {}", overload.result);
            println!("  returns:    {}", overload.returns);
            println!(
                "  types without the overload: {}",
                overload.typed_without_overload
            );
            match &overload.declared_instead {
                Some(ty) => println!("  declared instead: {ty}"),
                None => println!("  declared instead: none"),
            }
        }
    }
    Ok(parsed(&analysis))
}

fn corpus_report(root: &str, flags: &[&str]) -> std::io::Result<bool> {
    let root = Path::new(root);
    let prefix = root.file_name().map_or_else(
        || "patterns".to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let files = corpus::select(corpus::read_tree(root, &prefix)?, &prefix);
    if flags.contains(&"--files") {
        for file in &files {
            println!("{}", file.path);
        }
        return Ok(true);
    }
    let lines = files
        .iter()
        .map(|file| file.text.matches('\n').count())
        .sum();
    let analysis = analyze(&files);
    if flags.contains(&"--diagnostics") {
        for diagnostic in analysis
            .modules
            .iter()
            .flat_map(|module| &module.diagnostics)
            .filter(|diagnostic| {
                diagnostic.severity != pattern_compiler::diagnostics::Severity::Hint
            })
        {
            println!("{diagnostic}");
        }
        return Ok(parsed(&analysis));
    }
    let report = Report::build(&analysis, lines);
    if flags.contains(&"--json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(std::io::Error::other)?
        );
    } else {
        print!("{}", report.render());
    }
    Ok(parsed(&analysis))
}
