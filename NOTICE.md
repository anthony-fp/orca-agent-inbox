# Notice

Parts of this plugin are copied from the inbox repo, `github.com/anthony-fp/inbox`, at commit `272b367`, under its MIT license (see `LICENSE`). That repo is a fork of [petekp/inbox](https://github.com/petekp/inbox), the original inbox for Claude Code. The copied code was written in that project.

| File here | Copied from | Changes |
|---|---|---|
| `src/core/ledger.ts` | `hooks/ledger.ts` | Import paths only |
| `src/core/model-text.ts` | `hooks/model-text.ts` | Import paths only |
| `src/core/text.ts` | `hooks/text.ts` | None |
| `src/core/types.ts` | `types/index.d.ts` | Only the types the files above use |
| `src/core/ledger.test.ts` | `tests/ledger.test.ts` | The `applyUpdate` and `buildPrompt` tests, run on `node:test` |

`src/core/now.ts` is new.
