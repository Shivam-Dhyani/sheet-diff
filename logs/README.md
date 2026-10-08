# Project logs

Append-only daily logs (one `YYYY-MM-DD.md` per working day). They give every
developer — and every developer's Claude — the context of earlier changes
before touching the code (ADR-15).

- Add an entry under today's file for each meaningful change (what and why).
- `logs/*.md` is `merge=union` in `.gitattributes`, so parallel branches never
  conflict here.
- Logs are committed alongside the code they describe.
- **Dates are IST (Asia/Kolkata), not UTC.** Name each file by the current IST
  date: `TZ=Asia/Kolkata date '+%Y-%m-%d'`.
