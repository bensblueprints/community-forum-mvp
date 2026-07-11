# Launch strategy — Forumly

## Target communities

- **r/selfhosted** — the core audience; straight announcement with the SQLite/Docker/MIT trifecta and the honeypot fake-success detail (this crowd loves spam-defense war stories).
- **r/communitymanagers / r/CommunityManagement** — "the real cost of community platforms" breakdown post; disclose the tool, focus on platform-risk (price hikes, shutdowns).
- **r/Discord_Bots / creator subreddits** — angle: "graduating your Discord to a searchable forum without renting Circle."
- **r/Entrepreneur** — story post: paying $1,068/yr for a discussion board vs owning one; link in comments.
- **Indie Hackers** — build-in-public: the XSS-by-construction rendering model and why "no HTML pipeline" beats sanitizers.

## Show HN draft

**Title:** Show HN: Forumly – self-hosted community forum (Circle is $89/mo)

Community platforms bundle courses, payments and video to justify $89–399/mo — but the daily-use feature is the discussion board, and that's been a solved problem since phpBB. Forumly is a modern, minimal take: Node/Express/better-sqlite3 + React, one process, one DB file.

Two design decisions HN might find interesting:

1. Stored XSS is prevented by construction, not by filtering. Posts are stored as raw text and only ever leave the server inside JSON; the client renders them as React text nodes. There's no sanitizer to bypass because there's no HTML pipeline at all. The smoke test posts a <script> payload and asserts it appears in exactly zero HTML responses.

2. The honeypot returns a fake success. Bots that fill the hidden field get a 201 and nothing is stored — they never learn they were caught, so they don't adapt. Combined with minimum time-to-post and a per-IP sliding-window rate limit, tunable via env.

Everything else is the forum you remember: categories, threads, one-level nesting, emoji reactions, profiles with manually-awarded badges, @mention/reply notifications, search, pin/lock/ban moderation. MIT licensed; the paid product is a packaged installer.

## SEO keywords

1. circle.so alternative
2. discourse alternative self hosted
3. community forum software free
4. online community platform one time purchase
5. self hosted forum software modern
6. forum software with reactions and mentions
7. nodebb alternative lightweight
8. private community platform own server
9. forum spam protection honeypot
10. tribe circle alternative cheap

## AppSumo / PitchGround pitch

Forumly gives creators and businesses the piece of Circle their members actually open every day — the discussion forum — as a $39 one-time purchase instead of a $1,068+/yr subscription. Modern dark UI, threads with reactions and @mentions, member profiles with badges, notifications, search, and genuine moderation tools, all self-hosted in one Docker container with the entire community in a single SQLite file. Built-in spam defense (honeypot with fake-success, time-gate, rate limits) means it survives the public internet on day one. For an LTD audience full of community builders burned by platform pricing, "own your community forever" sells itself; comfortable margin at a $49–79 LTD tier with the installer and updates.

## Pricing math

**$39 one-time.** Circle starts at $89/mo → Forumly pays for itself in **13 days**. Hosted Discourse starts around $50/mo → under a month. Even against a $20/mo managed NodeBB instance, you're ahead in two months — and there's no month 25 invoice.
