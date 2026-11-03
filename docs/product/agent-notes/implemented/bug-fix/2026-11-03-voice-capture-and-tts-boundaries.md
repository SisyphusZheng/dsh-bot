# Agent Note: Voice capture boundaries and TTS fragment safety

Status: implemented

English | [中文](2026-11-03-voice-capture-and-tts-boundaries.zh.md)

## Problem

Three defects shared one boundary: speech that started right after playback ended was treated as a barge-in of the finished playback, so the first two words confirmed an interruption, ducked the volume and closed the capture early. The rest of the sentence then arrived after the capture boundary and became a "late" draft. Separately, the hold capture gave a slow ASR final only three seconds before closing, and TTS sent punctuation-only or split-markup fragments that the provider answered with zero audio, leaving silent holes in replies.

## Decision

Barge candidates are created only while playback is actually open; speech after it ends is a new utterance. The hold drain is six seconds, so a slow final stays inside its capture instead of becoming a late draft. TTS strips residual inline markup and leading sentence punctuation, and skips fragments with no speakable content instead of sending an empty request.

## Alternatives considered

- Keep the playback-tail barge window and only deduplicate candidates: the early confirmation still cuts the utterance.
- Keep the three-second drain and let the UI confirm late text: this is the behaviour users reported as "it only heard the first two words".
- Retry empty TTS responses: provider behaviour is not deterministic; the safe rule is not to send fragments the provider cannot speak.

## Consequences

Talking immediately after a reply submits a normal turn, and short answers are no longer split into drafts. A genuinely late final still produces a one-time notice. Provider-side empty responses for rare sentences remain possible and are recorded for the local-STT/TTS evaluation.
