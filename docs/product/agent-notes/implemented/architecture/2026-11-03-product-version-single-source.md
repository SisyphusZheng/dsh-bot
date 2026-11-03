# Agent Note: One product and runtime version identity

Status: implemented

English | [中文](2026-11-03-product-version-single-source.zh.md)

## Problem

The product version and the embedded runtime version were copied into several places and could drift silently; the Host could report an old version after a packaging change.

## Decision

The desktop shell is the single runtime source: it injects `app.getVersion()` and the runtime manifest version into the Host spawn environment, and the Host reports `unknown` when the identity is missing instead of falling back to a stale literal. A guard test forbids the declared product version from being embedded as a literal in the Host bundle, and `dev-doctor` treats version drift as a failure.

## Alternatives considered

- Keep a version literal in each package and reconcile manually: the drift is exactly what happened.
- Derive the version from the packaged manifest only: works for the app but not for source launches and tests.

## Consequences

Version facts come from the packaged artifact or from an explicit environment value. A release that forgets to update a version fails a gate instead of shipping a mixed identity.
