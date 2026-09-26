use local_custody::{describe_error, Activity, DescribeOptions};

const NAMES: DescribeOptions<'static> = DescribeOptions {
    product: "Textbutler",
    command: "textbutler",
    start_command: None,
    input_command: None,
    input_example: None,
    during: None,
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
            ..NAMES
        },
    );
    assert_eq!(
        tty.message,
        "Ghostget doesn't read this value from typing, so it stays out of your terminal history."
    );
    assert_eq!(
        tty.next,
        "Pipe or redirect the value into ghostget login --stdin."
    );
    let example = describe_error(
        "tty",
        &DescribeOptions {
            input_example: Some("ghostget login --stdin < token.txt"),
            ..NAMES
        },
    );
    assert_eq!(example.next, "ghostget login --stdin < token.txt");
}

#[test]
fn generic_rust_codes_follow_the_activity() {
    let control = DescribeOptions {
        during: Some(Activity::Control),
        ..NAMES
    };
    assert_eq!(
        describe_error("connect", &NAMES).problem,
        "service-not-running"
    );
    assert_eq!(
        describe_error("not-found", &control).problem,
        "service-not-running"
    );
    assert_eq!(describe_error("read", &control).problem, "service-timeout");
    assert_eq!(
        describe_error("json", &control).problem,
        "service-unexpected"
    );
    assert_eq!(
        describe_error("not-found", &NAMES).problem,
        "files-unavailable"
    );
    let input = DescribeOptions {
        during: Some(Activity::Input),
        ..NAMES
    };
    assert_eq!(describe_error("limit", &input).problem, "input-too-large");
}

#[test]
fn unknown_codes_are_unexpected_and_names_cannot_inject() {
    let unknown = describe_error("encode", &NAMES);
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
            ..NAMES
        },
    );
    assert_eq!(
        evil.message,
        "Evil [31m{command} stopped because its private files can be read by other users or aren't owned by you."
    );
}
