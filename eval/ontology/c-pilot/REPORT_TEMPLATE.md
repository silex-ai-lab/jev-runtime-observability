# C pilot report template (frozen at F-CP)

The report `ontology-typed-alerting/logs/2026-10-07_ONTOLOGY_C_PILOT_REPORT.md` follows this outline. Every number comes
from `logs/c-pilot/pilot.json` (or `pilot-primary.json` if the authored phase could not run). `<STATEMENT>` is the
`statement` string of `pilot.json`, verbatim.

1. **Header.** Status, the user decision (option (i)), the plan and freeze record, `pilot.json`'s sha256, and
   `<STATEMENT>`.
2. **What was run.** Seal, code closure and binding hashes; counts (runs, attacked, clean, calls, call-free runs,
   unregistered calls, `label_error`); the P0 build risk (an unlisted envelope or message key existed) and what the
   converter did with it.
3. **Primary table** (labels from the run files, S1 rule). Pooled and per suite, nine cells: F, TP, Pos, precision,
   recall, `recall_step`, `precision_step_one_more_false_alert`. Clean-run false alerts per cell. `<STATEMENT>` under
   the tables.
4. **Point differences** (primary table, in points), listed without any margin, threshold or verdict:
   precision typed × V3 − typed × V2; recall typed × V3 − bound × V1; recall typed × V3 − typed × V2; precision
   typed × V3 − bound × V1; recall typed × V3 − regex × V1. Note that bound ≡ typed on this binding, so the
   bound × V1 comparison equals typed × V1.
5. **Authored table** (labels transcribed from `MANIFEST.md` after the primary run, checked by reviewer-codex).
   Same layout; unmapped count; cross-check agree/disagree/unmapped; clean-run false alerts by authored category
   (`benign`, `benign-acting`), marked post-hoc. `<STATEMENT>` under the tables.
6. **Disclosures.** Authored-not-executed runs; author = coder-mimo, also binder A; the interrupted
   authoring-session incident; tool names and keys extracted from the runs by the W1 planner; the three
   planner-resolved parameter classes; the firewall tools have no hazard-relevant parameter.
7. **What this does not show.** No test, no estimate for fresh tasks, models or deployments; the set is now spent and
   excluded from any confirmatory C evaluation; a confirmatory H-C1 test needs option 2 or 3 and explicit spend
   approval.
8. **Gate record.** PLAN-CP, P0 gate, CG-CP, F-CP, the run, CR-CP.

The report never contains run text, run ids, run paths or per-run rows.
