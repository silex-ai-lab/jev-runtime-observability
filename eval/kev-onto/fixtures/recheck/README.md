# Independent Python recheck fixtures

Run the synthetic acceptance script from the repository root:

```sh
python3 -B eval/kev-onto/fixtures/recheck/test.py
python3 -B eval/kev-onto/recheck_ko.py g1 eval/kev-onto/fixtures/recheck/g1-balanced.json --include-scores
python3 -B eval/kev-onto/recheck_ko.py g1 eval/kev-onto/fixtures/recheck/g1-pipeline.json --include-scores
python3 -B eval/kev-onto/recheck_ko.py aggregate eval/kev-onto/fixtures/recheck/aggregation.json
```

`auroc.json` is hand-computable. Stratum `s` has 3.5 concordant pairs of 4, `t` has zero of 1,
and `u` has no negative. Pooling pairs gives 0.7. The supplied multiplicities give 10.5
concordant pairs of 13, or 21/26.

`g1-balanced.json` puts an identical positive and negative in each grouped fold. Every target
encoding is 0.5. The logistic optimum is the zero vector, so every combined probability and
both kinds of AUROC are 0.5. The test also checks a separate logistic problem against its
analytic scalar optimality equation, rather than against another implementation.

`g1-pipeline.json` isolates a perfect pipeline shortcut with every legacy feature constant.
Each fold contains both categories and labels, so the pipeline's OOF rates equal the labels
and its single and combined AUROC are 1. The test independently solves the logistic optimum
`b = 1 / (2 * (1 + exp(b)))` and checks the probabilities. The categories U+1F600 and U+E000
also distinguish UTF-16 sorting from Unicode code point sorting. Matrix capture verifies
that the pipeline block follows all legacy columns and that held-out-only categories activate
the unseen column. In-memory variants cover constant pipeline, unseen categories, one-class
complements and invalid pipeline values.

`aggregation.json` includes a successful multi-call run, a call-free benign run, a persistent
candidate failure and a label error. Any failed item excludes its whole run for both models
and both questions. Call-free runs have score zero; other scores are the per-question maximum.
The test modifies this fixture in memory to check missing and duplicate predictions.

The script also uses the shared `../g1/` degeneracy fixtures. All other populations it builds
are synthetic, including the bootstrap cohorts. It does not open benchmark trajectories.

## Interfaces for later comparison

The module docstring specifies JSON/JSONL inputs. The `g1` CLI expects admitted records already
projected onto a single question; it does not tokenize or reconstruct training data. Source and
family are strings, impact is `read`/`write`, and labels are JSON booleans. Optional score vectors
retain input order. Lengths and category sorting use JavaScript UTF-16 semantics.

For §9.7, supply a string `pipeline` on every record to add its OOF target-encoded single
feature and its training-vocabulary one-hot block (including an unseen column) after the
existing blocks, including standardized log length. If every record omits `pipeline`, the
v1/v2 feature set and output schema are preserved. Mixed presence or non-string values are
rejected because the spec does not define a missing-pipeline category. `source` and `family`
remain supplied projections; the v3 caller supplies constant source and suite as family.

Section 9.7 requires report-only OOF injection-text visibility AUROC for both questions and
OOF target-encoded candidate-tool-name AUROC for goal deviation. It does not alone define
how visibility is determined or how those diagnostic inputs are represented/extracted in
recheck records. This recheck does not invent those definitions or emit diagnostic scores.

The `aggregate` CLI accepts terminal predictions after retries, with `attempts` between one and
four. It never calls a model. Each observation must have both question items; an absent item or
prediction excludes the run. Returned `scores[question][checkpoint]` can be written as RunScore
JSONL. Pass the same output's `cohort_runs` and `excluded` fields as `--exclusions` metadata to
`evaluate`. This preserves the original denominator for the exclusion bound.

`evaluate` requires identical run identity sets and label/cluster metadata across checkpoints.
It computes both endpoints from one bootstrap frame over surviving E-mix runs. E-att filters
that shared frame without drawing again. `--include-draws` emits each endpoint's delta vector,
using JSON null for undefined draws. G1's optional probability vectors and the bootstrap
vectors support later numerical comparisons after the implementation hash is recorded.

The importable `g1_outcome` helper implements A1. Instruction-only failure first returns a
request to remove the entire instruction-override question entries and recheck goal G1. A
passing reduced-set result is required to finalize the disclosed goal-only path. The helper
does not mutate records or build training data.

No TypeScript implementation or output was used to construct these tests.
