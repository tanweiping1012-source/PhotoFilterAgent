# Acceptance dataset preflight

## Why this gate exists

An oracle directory can be correctly excluded from the selector scan while the acceptance run is still invalid.
This happens when a human pick was moved out of the candidate pool: the selector never had a chance to select the
ground-truth images, so the later overlap metric cannot measure selection accuracy.

Before any paid scoring, run:

```bash
node scripts/validate-acceptance-dataset.mjs \
  --source-root /absolute/path/to/acceptance-view \
  --oracle /absolute/path/to/acceptance-view/me-pick \
  --exclude-relative me-pick \
  --target 20
```

The gate passes only when:

1. the candidate pool, after excluding the oracle subtree, contains at least K images;
2. the oracle contains exactly K images;
3. every oracle image content instance is present in the candidate pool.

Comparison uses streaming SHA-256 and multiset semantics. The script is local-only and read-only. Its output is
limited to aggregate counts, coverage, capacity, target alignment, and a boolean result. It never emits paths,
filenames, hashes, or membership identities. None of its internal hashes or matches may be provided to the selector
or used to tune the current run.

Exit code 0 means the dataset is structurally valid for later overlap evaluation. Exit code 2 means a count,
capacity, or content-coverage gate failed. Exit code 1 means the requested paths or arguments violated the boundary.
Passing this preflight does not mean the model scored the images, the independent audit passed, or overlap reached
90%; those gates still require a frozen audited receipt.
