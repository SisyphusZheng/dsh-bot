# Agent Note: User-authoritative Bot permission preset

Status: implemented

English | [中文](2026-11-03-user-authoritative-permission.zh.md)

## Problem

The Bot session was pinned to a workspace-write bundle on every cold start while the visible permission selector showed the user's own choice "full access". The front-end and the effective sandbox disagreed, and a user who explicitly granted full access still met approval prompts for ordinary writes.

## Decision

The Bot profile delegates its preset (`permissionPreset: user-default`). The Host resolves it from the user's restored session selection, then from the configured DSH default, then from the safe bundle; an explicit Bot setting may pin a tier. The settings page exposes the tier (follow DSH / workspace-write / full access), so the visible permission and the applied sandbox have one source. The safe default stays workspace-write plus per-action approval.

## Alternatives considered

- Keep forcing the safe bundle and only change the UI copy: still a lie whenever the user chose full access.
- Drop the safe default and always run full access: unacceptable for a default install.
- Honor only the settings value and ignore the restored session: loses the user's last in-session choice after a restart.

## Consequences

A user who selects full access gets it, including after cold start, and the audit log records the change. A missing or malformed permission service falls back to the safe bundle instead of running wider than requested.
