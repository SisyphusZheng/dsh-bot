# Agent Note: Public repository keeps decisions, not audit evidence

Status: implemented

English | [中文](2026-11-03-public-repo-and-internal-evidence.zh.md)

## Problem

The closure cycle produced audit, acceptance and UAT records next to the product code. They contain machine-local paths, real-library operations and personal acceptance facts that should not be published, and a branch history that adds then deletes them would still expose them in public commits.

## Decision

The public repository carries product decisions and evidence-free documentation only; the internal `review/` evidence is archived locally (hidden, git-ignored) and never committed. Product decisions are published as Agent Notes under `product/agent-notes/`, mirroring the upstream `.agents/notes` convention. A public branch is published as a squashed snapshot on top of the public base, so no internal record survives in its history.

## Alternatives considered

- Commit the evidence and delete it later: it remains in public history.
- Publish the full local history and rely on a private archive: the history would leak the same records.
- Put product decisions into upstream `.agents/notes`: mixes product and upstream lineages and complicates upstream syncs.

## Consequences

The public tree is review-free and reproducible; the internal archive keeps the raw evidence for audits. Updating the public branch means producing a new squashed snapshot and force-with-lease, which is acceptable while the branch is a product snapshot rather than a collaboration branch.
