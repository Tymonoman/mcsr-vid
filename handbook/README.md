# Handbook

The operator's pages — how the channel is run, not how the code works (that is the root
`README.md` for the commands and `CLAUDE.md` for the rules and the pitfalls).

| Page | What it is |
| --- | --- |
| [studio-routine.md](studio-routine.md) | The YouTube Studio fallback: adopting a hand upload, and pinning, end screens and related links when the Studio worker reports `needsHuman`. |
| [api-review/](api-review/README.md) | The YouTube API Services compliance review, cleared 15 Sept 2026: the reply, the round-2 reply and the screencast script. Kept because Google may re-review. |
| [knowledge/](knowledge/) | The channel's reports (competitors, audit, audience, YPP, edcr, Studio automation) and `channel.md`, the briefing: what Telegram's `/ask` sends to Claude Haiku (only counts, titles, ids; no viewer comments). |
| [domain-setup.md](domain-setup.md) | `mcsr.sezamki.site`: the GitHub Pages site (`docs/`) that carries the OAuth homepage, privacy and terms pages. |
| [x-setup.md](x-setup.md) | X posts: creating the account and developer app, the four keys in `/app/.env`, the first post by hand, then `xAutoPost`. Costs about $0.20 a post. |
| [../branding/README.md](../branding/README.md) | The logo and banner, and how to regenerate them from the overlay's palette and badge. |
| [../deploy/mcsr-claude.service](../deploy/mcsr-claude.service) | The lab's systemd user unit for the Claude container. |
