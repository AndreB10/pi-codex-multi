# Changelog

## 1.1.0 - 2026-11-18

- Automatically discover new Codex models from Pi's public catalog for every account.
- Follow Pi's native model-refresh lifecycle with four-hour caching, ETag revalidation, offline restoration, and cancellation support.
- Keep catalog discovery independent of account tokens and OAuth refresh.
- Add 20 regression tests, including native Pi Models lifecycle and account isolation coverage.
- Require Pi 1.5.2 or newer.
