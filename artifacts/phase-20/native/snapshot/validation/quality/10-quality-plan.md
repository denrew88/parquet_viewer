# Independent quality plan — native CSV experiment

Execution mode: test design, then focused independent verification. This is experiment/provider validation
associated with Phase 15, not a Phase status transition. Root owns shared scope/integration documents.
No product code changes. Source baseline: existing csv-native-parquet/src/main.rs and size variant.

| ID | Contract | Layer / fixture | Expected | Owner |
| --- | --- | --- | --- | --- |
| Q-001 | Unsupported profiles fail closed | CLI: trim/tokens/separators/failure policy/timezone/duration/invalid enum/resolved Skip | Clear rejection before final publication; owned partial cleaned | Quality |
| Q-002 | Default CSV lexical parity | BOM + quoted first field/header, no header, CR/LF/CRLF, escaped quotes, multiline, blank records | Same rows/raw/typed/state as Polars and explicit CSV oracle | Quality |
| Q-003 | Numeric lexical parity | Signed/unsigned whitespace/sign/overflow; float exponent/NaN/Inf/negative zero | Full decoded parity; -0 bits preserved, NaN canonical comparison | Quality |
| Q-004 | Malformed input isolation | Truncated quotes/extra width/invalid UTF8/header mismatch | Error, no final, no owned partial; input unchanged | Quality |
| Q-005 | File fault isolation | Existing final/partial, missing parent, output directory, source alias | No overwrite/data loss; deterministic error | Quality |
| Q-006 | Bounded untrusted input | Long record/read chunks/256 columns | Explicit limits; note post-read allocation is not a hard memory guard | Quality review + root execution |
| Q-007 | Shape/performance matrix | Batch 65535/65536/65537; widths 31/32/33/64/65/255/256; long/low/high cardinality | Full independent oracle and repeated fair A/B | Root |
| Q-008 | Full app lifecycle | >64MiB native CSV (actual fast lane), cache hit, page/filter/sort/copy/cancel | Actual candidate backend evidence, no stale/broken data | Platform + root |
| Q-009 | Publication races and worker protocol | Source mutation, cancel/error, destination conflict | No success after mutation/cancel; no final overwrite | Root + quality review |

Critical: existing app's fast lane threshold is 64MiB. Small native GUI fixtures exercise Rust fallback.
The standalone CLI's narrower profile rejection is distinct from product parent eligibility guards.
Existing post-read 8MiB record checking is an acknowledged prototype production blocker; don't count it
as an enforced allocation cap. Tests must preserve semantic mismatches, not redefine them as unsupported.

Root owns conventional randomized numeric/shape oracle and performance; quality owns focused lexical,
profile and file-fault matrix in this folder. UI was not modified; native runtime evidence comes from
platform agent and is not inferred from browser mocks. Whole app GUI/installer gates remain separate.
