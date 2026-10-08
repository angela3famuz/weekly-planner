# Thread (formerly Weekly Planner)

A local-first planner PWA. The active app is **[Thread](v2/)**, in [`v2/`](v2/).

**Your data stays on your device** (browser `localStorage`). Sync is optional and goes
through a private GitHub gist — there's no server. See [`v2/README.md`](v2/README.md).

## What this is

Thread is a present-tense planner: meetings are *threads* (distil a transcript and the next
one opens knowing where you left off), plus a weekly cockpit, a schedule grid, colour-coded
categories, meeting done/missed tracking, a weekly productivity view, `.ics` and photo import,
reminders, and cross-device sync. Full details are in [`v2/README.md`](v2/README.md).

Open it: **https://angela3famuz.github.io/weekly-planner/v2/**

## v1 is retired

The original single-file Weekly Planner (at the repo root) has been retired. Its features live
on in Thread, and the migration path is built in — a v1 backup imports straight into Thread via
**Restore**, categories and all.

The root URL (`.../weekly-planner/`) now shows a short landing page that redirects to Thread. If
a device still has old v1 data in `localStorage`, that page offers a one-time **download** of it
first, so nothing is stranded; then **Restore** it in Thread.

The old v1 source remains in git history. The never-deployed server-based sync design
(`server/`, `docs/sync-design.md`) has been removed — Thread's gist sync replaced it.

## Layout

| Path | Purpose |
| --- | --- |
| `v2/` | **Thread** — the app. See its README. |
| `index.html` | Retirement landing page: rescues leftover v1 data, redirects to `v2/`. |
| `manifest.webmanifest`, `sw.js`, `icons/`, `tools/` | Leftover v1 assets, kept only so existing v1 installs resolve cleanly. |
