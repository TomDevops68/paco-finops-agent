# Lessons

## Dropping an optional object field under `exactOptionalPropertyTypes` + strict lint (2026-09-30)

When an optional field must be conditionally removed from an object (e.g. "drop `sourceDiscrepancy` if
its evidence doesn't validate") under `exactOptionalPropertyTypes: true` _and_ an ESLint config with no
`varsIgnorePattern`/`argsIgnorePattern` override:

- **Don't** do `{ ...input, ...(valid ? { field } : {}) }` — the empty-object branch is a no-op, so an
  invalid value already present from `...input` silently survives instead of being dropped.
- **Don't** destructure it out (`const { field: _dropped, ...rest } = input`) — an unused destructured
  var fails `@typescript-eslint/no-unused-vars` when no ignore pattern is configured.
- **Do** build the object omitting that key from its own literal, then immediately after:
  `if (valid) obj.field = value; else delete obj.field;` — `delete` is valid on an optional property and
  never assigns an explicit `undefined`, satisfying `exactOptionalPropertyTypes`.

Check `tsconfig.base.json` for `exactOptionalPropertyTypes` and `eslint.config.js` for
`varsIgnorePattern` before picking an approach — don't assume either is set/unset.

## A shared CDK Step Functions construct can only ever have one `.next()` (2026-09-30)

When multiple branches of an ASL graph need to converge through the same intermediate state (e.g. a
shared failure handler, or a helper that wraps "notify then continue" reused across several terminal
outcomes), **never call `.next()` on that same construct instance more than once with different
targets** — CDK's `.next()` mutates the underlying state's `Next` field, so the second call silently
overwrites the first, and only the last-registered target ever actually gets reached at runtime.
`tsc`/lint/`vitest` all stayed green through this — it only shows up as a graph defect once you either
`cdk synth` and read the produced ASL, or (worse) hit it live in the Step Functions console.

- **If different branches need different follow-up targets**: don't share one construct — build a
  fresh one per call site (a factory function taking a unique id string, since CDK construct ids must
  be unique within a scope anyway: `` `${id}Foo` ``), even if the TaskInput/payload is byte-for-byte
  identical across all of them.
- **If different branches genuinely converge to the exact same next state** (this codebase's
  `failMissingReport`, reused by both `REPORT_NOT_FOUND` and `LINE_NOT_FOUND`): that's fine and does
  **not** need a fresh construct per branch — just call `.next()` on the shared construct exactly
  once, then reference that same object from every `Choice.when()`/`.otherwise()` branch that should
  land there. The bug is specifically re-calling `.next()` with _different_ targets, not reuse itself.
- This only surfaces via `cdk synth` (inspect the synthesized `DefinitionString` for the state machine,
  or count occurrences of a state name — each terminal branch that should reach it needs its own
  distinct construct id if targets differ) — `pnpm build`/`lint`/`typecheck`/`test` cannot catch it,
  since `IChainable`/`.next()` are both structurally valid TypeScript regardless of how many times
  `.next()` is called. Always `cdk synth` after any ASL restructuring, not just after adding a new
  Lambda/Task.
