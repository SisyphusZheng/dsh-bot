# Product Agent Notes

English | [中文](README.zh.md)

This directory mirrors the upstream `.agents/notes` convention for **product-owned** decisions of Nisse / dsh-bot. It is a mirror, not a second notes tree in the upstream gate: upstream Agent Notes stay in `.agents/notes/`, product decisions live here so upstream syncs do not mix lineages.

- Path: `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`; lifecycle is `implemented`, `proposed` or `rejected`; class is one of `architecture`, `bug-fix`, `feature`, `process`, `simplification`, `testing`.
- Every note is a bilingual triplet: `.md`, `.zh.md`, and `.i18n.yaml` recorded by `pnpm run verify-translation-pairing --write <note>.md`.
- A note records a decision: the problem, the decision, alternatives considered, and consequences. It is kept current with what shipped; a reversal needs a new note and a cross-link.
- **Audit and acceptance evidence does not belong here.** Security reviews, UAT records, artifact identities, logs and screenshots stay in the local, unpublished `.agent/review/` archive; this directory is intended for publication.
