use local_custody::{describe_error, terminal_input_message, DescribeOptions};

const NAMES: DescribeOptions<'static> = DescribeOptions {
    product: "Textbutler",
    command: "textbutler",
    start_command: None,
    input_command: None,
};

// These goldens match src/describe.test.ts; both read the same generated table.
#[test]
fn service_and_input_copy_match_node() {
    let stopped = describe_error(
        "control-unavailable",
        &DescribeOptions {
            start_command: Some("textbutler daemon start"),
            ..NAMES
        },
    );
    assert_eq!(stopped.problem, "service-not-running");
    assert_eq!(
        stopped.message,
        "Textbutler's background service isn't running."
    );
    assert_eq!(stopped.next, "textbutler daemon start");
    assert_eq!(
        describe_error("control-unavailable", &NAMES).next,
        "textbutler doctor"
    );

    let tty = describe_error(
        "tty",
        &DescribeOptions {
            product: "Ghostget",
            command: "ghostget",
            input_command: Some("ghostget login --stdin"),
            start_command: None,
        },
    );
    assert_eq!(
        tty.message,
        "Ghostget reads this value from a pipe, not from typing, so it stays out of your terminal history."
    );
    assert_eq!(tty.next, "pbpaste | ghostget login --stdin");
    assert_eq!(describe_error("tty", &NAMES).next, "pbpaste | textbutler …");
}

#[test]
fn unknown_codes_are_unexpected_and_names_cannot_inject() {
    let unknown = describe_error("json", &NAMES);
    assert_eq!(unknown.problem, "unexpected");
    assert_eq!(
        unknown.message,
        "Textbutler hit an unexpected problem with its private files."
    );
    let evil = describe_error(
        "owner",
        &DescribeOptions {
            product: "Evil\u{1b}[31m{command}",
            command: "evil",
            start_command: None,
            input_command: None,
        },
    );
    assert_eq!(
        evil.message,
        "Evil [31m{command} stopped because its private files can be read by other users or aren't owned by you."
    );
}

#[test]
fn terminal_message_is_actionable() {
    assert!(terminal_input_message().starts_with("Pipe the value in instead of typing it"));
}
