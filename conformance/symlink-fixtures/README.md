# Shared symlink / rename scope fixtures (A-SEC-4)

Language-neutral fixtures that pin TS↔Python parity for symlink and rename/link
scope escapes (invariant 8). Unlike the lexical `conformance/fixtures/`, these
require a REAL filesystem: each fixture declares a `setup` (dirs, symlinks,
files) that the parity harness materializes under a fresh temp root before
resolving the scope verdict in both languages.

Kept in a separate directory from `conformance/fixtures/` so the existing
lexical conformance runners (which take pre-canonicalized string inputs) do not
pick them up.

## Fixture format

```json
{
  "id": "symlink-001-escape-via-symlinked-dir",
  "description": "symlink escaping the declared dir denies the escaped write",
  "setup": {
    "dirs": ["declared", "declared/sub", "outside"],
    "symlinks": [{ "link": "declared/root", "target": "/" }],
    "files": ["outside/secret.txt"]
  },
  "declaredPaths": ["declared"],
  "targetPath": "declared/root/etc/passwd",
  "destinationPath": null,
  "isWrite": true,
  "expected": "DENY"
}
```

- Paths in `setup`, `declaredPaths`, `targetPath`, `destinationPath` are relative
  to the temp root unless the symlink `target` is absolute (leading `/`).
- `expected` is the scope verdict `result` (`ALLOW` or `DENY`).
- `destinationPath` (optional) exercises rename/link BOTH-endpoint checking.
</content>
</invoke>
