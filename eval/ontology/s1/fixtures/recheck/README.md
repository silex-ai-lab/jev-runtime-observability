# Independent S1 fixtures

Run from the jev repository:

```
python3 eval/ontology/s1/recheck_s1.py --selftest
node eval/ontology/s1/fixtures/recheck/converter.test.ts
```

All inputs are synthetic. The Python suite covers equality at the recall constraint, K=6/5/4, a zero-positive base model, exact sign-flip enumeration, grouping and secondary tables, zero flags, fewer than 60 positives, a zero-flag random draw, redraw exhaustion, deterministic bootstrap and independent sanitization/recognisers. The converter fixture uses the same pipeline/user/injection identifiers under two attacks, verifies distinct run/observation IDs, single ownership of clean runs, unchanged observation fields, and rejects invalid cohort configurations.

The checker copies the independent PR extraction implementation and reuses independent Python AL/v2/v1 statistical helpers; it neither reads nor imports TypeScript statistics. Sign-flip and constraint sums explicitly accumulate doubles in sorted base-model order. Undefined CI members remain null in the specified CI object; undefined secondary tests are null.
