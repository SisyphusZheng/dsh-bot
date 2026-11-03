# Agent Note: Terminal drafts leave the confirmation projection

Status: implemented

English | [中文](2026-11-03-terminal-draft-projection.zh.md)

## Problem

After a voice draft was rejected, confirmed or expired, the conversation service still projected it as a pending confirmation. The pet bubble never closed, every snapshot re-opened it, and a second discard answered 409, trapping the user in the discard action.

## Decision

The projection only carries a live confirmation window (`pending`, `editing`, `submitting` and not expired); terminal drafts stay in bounded history but are not projected. A capture that the user discarded is not offered again for later revisions of the same capture, and the regression tests cover both the projection and the re-offer suppression.

## Alternatives considered

- Clear the draft after every terminal command: equivalent for common paths, but a terminal draft restored from state could still leak into a snapshot.
- Keep projecting terminal drafts and filter them in the pet: two owners for the same rule, and every new client repeats the filter.

## Consequences

Discard closes the bubble immediately, and a late ASR revision cannot resurrect a dismissed capture. The user still sees a one-time late-input notice when a genuinely late final arrives, because that content is not silently dropped.
