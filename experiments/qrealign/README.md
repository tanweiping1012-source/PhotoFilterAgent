# Q-ReAlign local baseline experiment

This experiment is deliberately separate from the production selector until it
passes the preregistered stability and hidden-oracle gates.

- Model: `q-future/Q-ReAlign-Mini-0.8B`
- Frozen revision: `fe1f45a7574c9e9d908875af9f7e90cb946aa19f`
- `model.safetensors` SHA-256: `bde34df0375fff90d2dee716a127039c57d310c0c868b9f52f4fc2d1ead34aac`
- Task: aesthetics (`How would you rate the aesthetics of this image?`)
- Device for the acceptance baseline: CPU
- Preview detail: `standard`
- Photos: local anonymous JPEG previews over stdin only
- Output: anonymous IDs, scalar scores, protocol identity and stability metrics

The experiment identity binds the model revision, weight SHA-256, prompt,
runtime versions, preview detail, local eligibility policy, dataset fingerprint,
and requested K. Changing any of those inputs creates a different protocol hash.
Each anonymous item has an explicit timeout and emits a path-free progress event;
an interrupted or timed-out pilot writes no partial acceptance artifact.
Device availability is preflighted before the dataset is scanned, and an
unsupported accelerator fails closed without falling back to CPU.

The model process uses `local_files_only=True`; downloading the public weights
is a separate explicit setup step. The locked final pick set is never read by
this scorer.
