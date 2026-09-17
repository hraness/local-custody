# Contributing

Issues and focused pull requests are welcome in the hraness/local-custody
repository.

Open an issue before changing a protocol value, registry entry, public
subpath, dependency, or security invariant. Maintainers review changes for
closed authority, runtime separation, source compatibility, exact parsing,
and deterministic evidence.

Use Bun 1.3.14 and run the complete local gate before opening a pull request:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Include a readable regression test for each behavior change. Add a property
test for a parser, round trip, ordering rule, or other invariant over arbitrary
input. Never put credentials, provider state, webhook payloads, billing
catalog data, or private service implementation details in an issue, fixture,
commit, or pull request.
