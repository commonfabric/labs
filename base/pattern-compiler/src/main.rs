//! The command-line entry of the prototype front end.

use std::process::ExitCode;

use pattern_compiler::catalog;

const USAGE: &str = "\
usage: pattern-compiler <command>

commands:
  catalog   print each entry of the diagnostics catalog with its status
";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("catalog") => {
            print!("{}", catalog::render());
            ExitCode::SUCCESS
        }
        _ => {
            eprint!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
