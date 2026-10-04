# Independent P2 fixtures

Run from the jev repository root:

```sh
python3 eval/ontology/pr/recheck_pr.py --selftest
node eval/ontology/pr/fixtures/recheck/converter.test.ts
```

All inputs are synthetic. `test.py` builds the ontology, manifest, binding, labels,
observations and judge rows without reading any benchmark run or another PR implementation.
It covers sanitizer recursion, field exclusion, recognition order, UTF-16 qualification,
JavaScript number strings and whitespace, all-source decisions, failed/duplicate predictions,
zero flags/positives, fewer than 60 positives, infrastructure failure, the 2-point margin,
a random draw flagging no run, the redraw cap, secondary metrics and repeatability.
The more-alerts case intentionally demonstrates that better precision and recall need not
reduce alerts: H14 has no alert-load endpoint (unlike H13).
Ablation keys: stage1_only, route_P_only, route_V_only, threshold_0_3, threshold_0_7, source_trust.
Source binding uses version:1 and tools[id] objects with source_class and reason fields.
Source-trust matching requires tool_result:<name>#<index>; it does not read judge scores.
The converter fixtures test the separate secondary-label path, including clean runs,
task overlap, nested values, numerical values and email/domain overlap suppression.
