# Initial independent review — native converter

Mode: focused independent verification against experiment scope, not Phase completion.
Root owns implementation, performance/shape matrix and final integrated gate. This review does not
modify product or prototype code.

## Executed evidence

- `runs/initial/results.json`: 35 cases, raw 21 PASS / 14 FAIL, native binary
  `895acf7009f300fef3bf35fa52b4ec3043bd7d37eb7e71890d83a6f41178081b`.
- `runs/auto-initial/results.json`: 1 additional Auto-source case FAIL on the same binary.
- `runs/file-faults/results.json`: 6 file-boundary cases PASS.
- `runs/default/results.json`: initial sandbox attempt, 3 profile cases BLOCKED by hardlink os error 5.
  The root reran the full matrix in the allowed environment. Security policies were not modified.

The 15 raw failures require adjudication: 13 correspond to candidate defects, 2 are baseline behavior
differences where native follows the required existing csv parser semantics.

## Findings

### H-Q-001: admitted Auto source profile cannot deserialize

`src/main.rs::Target` lacks Auto. Default product profiles retain `targetType:"auto"` while separate
`resolvedTargets` contains concrete types. `profile_is_initial_fast_lane_candidate` explicitly admits
this combination. Native returns unknown variant auto before conversion; Polars succeeds.

Repro: `quality_matrix.py --label NAME --only source-auto`.
Source fixture: `c0\n1\n2\n`, source target Auto, resolved Int64.
Expected: normal conversion matching the concrete resolved type. Actual: exit 2, no final file.
Severity: HIGH integration blocker. Suggested fix: admit Auto only in source profile metadata and still
reject Auto/Skip in resolved targets. Parent eligibility must remain enforced.

### H-Q-002: UTF8 BOM corrupts StrictQuotes state for quoted first data field

`StrictQuotes` consumes initial BOM bytes as unquoted field content. A valid first quoted multiline or
escaped-quote value can then set the wrong quote state and return characters-after-closing-quote.
Both `bom-quoted-first-newline` and `bom-quoted-first-escaped` are rejected; Polars accepts them.

Repro fixture: `EF BB BF` followed by `"\n",1\r\n"x",2\r\n`, no header.
Severity: HIGH data-format regression for a documented supported encoding/dialect.
Suggested fix: ignore a single leading UTF8 BOM for grammar state, preserving parser data handling;
cover a BOM prefix split over reader chunk boundaries and non-BOM bytes beginning similarly.

### M-Q-003: incomplete fail-closed profile validation

The standalone profile Column omits failurePolicy, temporalFormats, timezonePolicy/offset and
durationUnit/inputFormat. Serde ignores those fields, so values outside the admitted defaults are
silently accepted. `failurePolicy:"fail"` with invalid numeric input publishes a result instead of
rejecting the unsupported setting; even invalid enum strings are ignored. A resolved Skip target
for a non-Skip source column is also accepted and silently removes its typed value column.

10 concrete cases FAIL in initial matrix (3 failure policy, 2 timezone policy, offset, 2 duration,
temporal format, resolved Skip). Severity: MEDIUM standalone/worker hardening blocker. Product parent
eligibility already checks all these settings, so this is not automatically a native GUI regression.
Suggested fix: deserialize/check all relevant defaults; reject non-concrete resolved targets before
opening output. Reuse the same admission contract rather than allowing validation rules to diverge.

## Baseline differences — do not force native to emulate

- `cr-only`: native succeeds; Polars rejects provided schema 2 != 4. `csv-core` documentation explicitly
  accepts CRLF, LF and CR as record terminators. Native matches this parser contract.
- `blank-lines`: native yields two rows `1`,`2`; Polars yields five rows empty/1/empty/2/empty.
  `csv-core` explicitly ignores empty lines. Product Pass A/count/checkpoints/state uses this parser.
  Native's row identity is correct for that existing contract. Polars output is unsuitable as the sole
  oracle for this fixture.

Local primary evidence: `csv-core-0.1.13/src/reader.rs:91–94`, StartRecord transition near line 990,
under the existing workspace Cargo registry. Independent Python CSV parsing plus removal of empty
records reproduces native values. Preserve original raw FAILs; classify these separately in final gate.

## Passing focused tests

Integer signed/unsigned lexical matrices (whitespace, signs, overflow/underflow, boundaries, null/empty)
and Float64 lexical matrix (exponents, infinity/NaN variants, underflow, negative zero) have full decoded
parity with Polars. UTF8 quoted escapes, 256KiB read-boundary quote data, malformed quote/width/UTF8
rejection and supported profile rejections pass.

File tests preserve existing final/partial sentinels, source-as-output, output/partial directories, and
reject missing output parent. No input changed. These are deterministic pre-publication faults, not
proof that disk-full or permission loss during write always cleans up.

## Static boundary review / remaining gates

- create_new partial + hard_link final provides no-overwrite publication. Source/output aliases fail
  before writing. On runtime failures owned partial cleanup is attempted; cleanup errors are ignored.
- Standalone conversion has no source fingerprint guard. Full-app worker retains start/end source
  identity/length/modified-time checks and rejects mutation before publishing worker result.
- Record byte limit is checked after csv has allocated/read a record. Initial builder capacity also
  scales with width. Bounded queue count is not a hard RSS or hostile allocation cap. This was already
  declared in experiment scope and remains a production blocker until strengthened.
- Native GUI tests must exceed the 64MiB fast-lane threshold and prove successful prepared artifact /
  backend, not just visible rows. Direct fallback can otherwise hide a broken new worker.
- No installer, real Excel, other OS or full product suite PASS is inferred by this review.

Root should fix H-Q-001/002 and M-Q-003, then rerun focused matrix and native actual-fast-lane tests.
Final adjudicated gate depends on root's independent data oracle and platform evidence.
