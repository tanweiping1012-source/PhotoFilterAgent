# DSH 0.2 release-candidate validation

Candidate: `@photo-filter-agent/dsh-photo-filter-v4@0.4.0-rc.1`.
Source baseline: `4e649bca13f4d3a4fc60a47362eb215740ea3ae3`.
Runtime: published `@deepseek-ai/dsh@0.2.0-rc.2`, verified 2026-09-30.
Platform tested: macOS arm64, Node 24.15.0. Other platforms are not certified.

## Results

| Check | Result | Evidence boundary |
| --- | --- | --- |
| TypeScript | PASS | Includes agent-v4 and release entry |
| Existing TypeScript suites | PASS | Six suites, including 16 ranking wiring scenarios |
| Active cancellation | PASS | Delayed-SIGTERM Python child exits before rejection and temporary-file cleanup |
| Python regression | PASS | 258 tests; no live model scoring |
| Setup patch edits | PASS | Preserves unrelated rows, comments and `!!js`, keeps backup |
| npm tarball installation | PASS | Real DSH plugin manager, fresh home and Web profile |
| Full Web startup | PASS | Loopback, random port, no browser auto-open |
| Preset and tools | PASS | PhotoFilter preset and seven registered tools |
| Scan/rank/export | PASS (fixture) | Real plugin and DSH; synthetic ranker returns fixture scores; actual copies checked |
| Session isolation | PASS | Second Agent cannot rank or confirm first Agent's export |
| Restart | PASS | Resume persisted sessions; in-memory shortlist and pending ticket do not survive |
| Swift build from tarball | PASS | Packaged sources and test-target directory compile independently |
| Real-photo model quality | NOT RUN | No private dataset or paid model requests in this acceptance |
| Cold dependency installation | PASS | New Python 3.12 venv, actual CLIP/pyiqa/torch imports, pip check, Swift build via installed setup command |
| Public npm publication | PENDING | npm whoami returned ENEEDAUTH; namespace ownership and repository license not yet confirmed |

## Reproduce

```sh
npm ci
npm run build
npm run typecheck
npm test
node scripts/setup.test.mjs
npm pack
npm install --prefix /tmp/photofilter-dsh-runtime @deepseek-ai/dsh@0.2.0-rc.2
node scripts/verify-dsh-release.mjs /tmp/photofilter-dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js ./photo-filter-agent-dsh-photo-filter-v4-0.4.0-rc.1.tgz
```

The verifier creates a new temporary DSH home, installs the exact tarball, and launches DSH twice. It reports the evidence directory and saves logs with Web tokens redacted. It intercepts model preparation and asserts zero attempted model dispatch. The ranking fixture tests integration, not CLIP/topiq quality.

The dedicated GitHub workflow runs build, tests, package installation and full runtime smoke on macOS. Existing frozen-data CI remains in place.

## Corrections found during acceptance

- DSH's current persona config requires `prefix`; the old `text` field fails preset activation.
- A preset revision is shared across Agents. Mutable shortlist/ticket state now belongs to the calling Session.
- Cancellation used to reject before child close, racing temporary-file deletion. The bridge now waits for close and escalates a stalled SIGTERM to SIGKILL.
- Swift's package manifest references a test target. Omitting its directory from the npm tarball prevents compilation; the release file list now includes it.
- Fresh cloud runners lack pnpm, which the npm DSH CLI requires. The source installer and verifier now use pinned pnpm from development dependencies.
- An early tool-only smoke disabled Web startup and could finish before required-service diagnostics. The final verifier starts the complete Web surface and waits for its services.

## Scope

Automatic stage 2 and stage 3 visual review are disabled in the new bundle. Historical experiment profiles are preserved and are not migration/install inputs. The explicit comparison tool can still use a model when requested. Conversation inference can incur charges even when local ranking does not.

The bundle targets existing Web/Desktop profiles. It does not add a CLI task runner to base-only profiles. No release, repository topic or npm publication has been made by this change.
