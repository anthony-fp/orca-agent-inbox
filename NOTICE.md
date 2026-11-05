# Notice

Parts of this plugin are copied from the inbox repo, `github.com/anthony-fp/inbox`, at commit `272b367`, under its MIT license (see `LICENSE`). That repo is a fork of [petekp/inbox](https://github.com/petekp/inbox), the original inbox for Claude Code. The copied code was written in that project.

| File here | Copied from | Changes |
|---|---|---|
| `src/core/ledger.ts` | `hooks/ledger.ts` | Import paths only |
| `src/core/model-text.ts` | `hooks/model-text.ts` | Import paths, and a new `ORCA` host |
| `src/core/text.ts` | `hooks/text.ts` | None |
| `src/core/tools.ts` | `hooks/tools.ts` | Import paths only |
| `src/core/plan.ts` | `hooks/plan.ts` | Import paths only |
| `src/core/tones.ts` | `hooks/tones.ts` | Only the `ToneName` type, which `plan.ts` uses |
| `src/core/types.ts` | `types/index.d.ts` | Only the types the files above use |
| `src/core/ledger.test.ts` | `tests/ledger.test.ts` | The `applyUpdate` and `buildPrompt` tests, run on `node:test` |
| `src/core/tools.test.ts` | `tests/ledger.test.ts` | The tests that call `recordItem`, `recordClose` and `agentTools`, run on `node:test`, and a new test for the `ORCA` host |
| `src/core/plan.test.ts` | `tests/plan.test.ts` | Run on `node:test` |

`src/core/now.ts` is new.
