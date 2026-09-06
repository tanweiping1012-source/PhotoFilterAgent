/**
 * Dedicated package boundary for Photo Curator Anchor Lab (Codex).
 *
 * Development imports the shared source tree so the experiment can reuse the
 * hardened engine, route and checkpoint code. The installer rewrites this one
 * relative import into a content-addressed, package-local runtime snapshot;
 * DSH never executes the mutable development tree.
 */
export * from '../../agent/src/anchor-lab-codex-plugin.ts'
