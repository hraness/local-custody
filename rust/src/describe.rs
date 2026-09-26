//! Plain-language explanations for custody failures, generated from the
//! TypeScript table in `src/describe.ts` (`bun run generate:error-copy`), so
//! Rust and Node products say the same thing and give one next step.

use std::sync::OnceLock;

use serde_json::Value;

use crate::CustodyError;

const ERROR_COPY: &str = include_str!("error-copy.json");

fn copy() -> &'static Value {
    static COPY: OnceLock<Value> = OnceLock::new();
    COPY.get_or_init(|| {
        serde_json::from_str(ERROR_COPY).expect("generated error copy is valid JSON")
    })
}

/// What the product was doing. Rust errors use generic codes (`read`,
/// `not-found`, `json`), so the same code means a stopped service during a
/// control request and a file problem elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Control,
    Input,
    Files,
}

impl Activity {
    fn key(self) -> &'static str {
        match self {
            Activity::Control => "control",
            Activity::Input => "input",
            Activity::Files => "files",
        }
    }
}

/// Names and commands used to fill the copy.
#[derive(Debug, Clone, Copy)]
pub struct DescribeOptions<'a> {
    /// The product's display name, such as `Textbutler`.
    pub product: &'a str,
    /// The product's command, such as `textbutler`. `{command} doctor` is the default next step.
    pub command: &'a str,
    /// How to start the product's background service, when it has one.
    pub start_command: Option<&'a str>,
    /// The full command that reads protected input, such as `ghostget login --stdin`.
    pub input_command: Option<&'a str>,
    /// A complete example that feeds the value in, such as
    /// `ghostget login --stdin < token.txt`. It replaces the default next step
    /// for terminal input.
    pub input_example: Option<&'a str>,
    /// What the product was doing when the error happened.
    pub during: Option<Activity>,
}

/// One sentence saying what happened and one next step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorDescription {
    /// The problem category, such as `unsafe-permissions`.
    pub problem: String,
    pub message: String,
    pub next: String,
}

fn plain(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            let format = matches!(c, '\u{00AD}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}' | '\u{2028}' | '\u{2029}');
            if c.is_control() || format { ' ' } else { c }
        })
        .collect();
    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

/// Explain a custody error code (a [`CustodyError::code`] or a sidecar `code`).
/// Unknown codes are described as unexpected. Internal details, paths and
/// codes never appear in the text.
pub fn describe_error(code: &str, options: &DescribeOptions<'_>) -> ErrorDescription {
    let problem = options
        .during
        .and_then(|activity| copy()["activityCodes"][activity.key()][code].as_str())
        .or_else(|| copy()["codes"][code].as_str())
        .unwrap_or("unexpected");
    let entry = &copy()["copy"][problem];
    let product = plain(options.product);
    let command = plain(options.command);
    let start = options
        .start_command
        .map_or_else(|| format!("{command} doctor"), plain);
    let input_command = options.input_command.map_or_else(|| command.clone(), plain);
    let input = options.input_example.map_or_else(
        || format!("Pipe or redirect the value into {input_command}."),
        plain,
    );
    let fill = |template: &str| {
        // Placeholders are filled in one pass so a name can never introduce another placeholder.
        let mut out = String::with_capacity(template.len());
        let mut rest = template;
        while let Some(start_at) = rest.find('{') {
            out.push_str(&rest[..start_at]);
            let tail = &rest[start_at..];
            let (value, width) = [
                ("{product}", product.as_str()),
                ("{command}", command.as_str()),
                ("{startCommand}", start.as_str()),
                ("{inputExample}", input.as_str()),
            ]
            .iter()
            .find(|(name, _)| tail.starts_with(name))
            .map_or(("{", 1), |(name, value)| (*value, name.len()));
            out.push_str(value);
            rest = &tail[width..];
        }
        out.push_str(rest);
        out
    };
    ErrorDescription {
        problem: problem.to_owned(),
        message: fill(entry["message"].as_str().expect("generated copy message")),
        next: fill(entry["next"].as_str().expect("generated copy next")),
    }
}

impl CustodyError {
    /// Explain this error in one sentence plus one next step.
    pub fn describe(&self, options: &DescribeOptions<'_>) -> ErrorDescription {
        describe_error(&self.code, options)
    }
}
