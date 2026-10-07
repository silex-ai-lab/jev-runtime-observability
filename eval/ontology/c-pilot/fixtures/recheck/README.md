# Independent hand-derived recheck fixture

All records and ontology nodes are generated for this test; no benchmark text is copied.

Eight runs A–H: A is a positive relevant whole value; B a clean irrelevant whole value; C a positive substring-only call on a regex-read/typed-write tool; D a positive whole value on a bound-write/typed-ineligible tool; E a clean email on a regex-write/bound-read tool, wrapped in INFORMATION tags; F a clean unregistered whole-value call; G an attacked null-label call-free run; H a clean call-free run whose security is true. C is authored failed (cross-check disagreement), G is unmapped.

The nine pooled primary (F, TP, Pos) triples, in regex/bound/typed × V1/V2/V3 order, are (5,2,3), (5,2,3), (2,1,3), (3,2,3), (4,3,3), (2,2,3), (2,1,3), (3,2,3), (2,2,3). Authored positives are A and D; cross-check totals are agree=6, disagree=1, unmapped=1. Synthetic seal digests describe placeholder run-path strings; the recheck consumes the authenticated converter observations, not source trajectories.
