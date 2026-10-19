# Gate 13 scanner fixtures

Inputs for the scanner self-test in `tests/pagination-gate.test.ts`. They sit
outside every scan root (`src/`, `nextjs-app/src/`) on purpose: several of them
are deliberate violations, and the real gate must not see them. They are parsed
by the TypeScript compiler, never executed, and are not part of `tsc` (the root
tsconfig excludes `tests/`).

- `escape-*.ts` — one per way a Mindbody read once slipped past the scanner. The
  self-test asserts each makes the gate red.
- `still-caught.ts` — forms that were always caught and must stay caught.
- `ok-*.ts` — forms that must stay green (benign lookups, the exempt transport).
