# 💬 Forumly

**Your community, your server. Pay once — forums existed before SaaS pricing did.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Forumly is a self-hosted community forum: categories, threads, one-level nested replies, emoji reactions, member profiles with badges, @mentions, notifications, search, and real moderator tools. Everything a paid community actually uses — without Circle's **$89+/month** or the ops weight of a hosted Discourse plan.

$39 once. Runs on a $5 VPS with Docker, or as a desktop app. All of it in one SQLite file you can back up with a copy-paste.

![screenshot](docs/screenshot.png)

## Features

- 🗂 **Categories → threads → replies** — one-level nesting for readability, thread pinning and locking, "new since your last visit" indicators.
- 😀 **Reactions** — six-emoji reaction set with toggling and per-member state.
- 👤 **Member profiles** — avatar (URL or generated initials), bio, join date, post count, and a manual-award **badge** system (🌟 Founding member).
- 🔔 **Notifications** — reply-to-your-thread and @mention notifications with an unread bell. (Email digest is a stub setting — nothing is sent; wire your own SMTP if you want it.)
- 🔍 **Search** across thread titles and post bodies with snippets.
- 🛡️ **Moderator tools** — pin, lock, delete any post/thread, ban members, award badges, manage categories. Separate admin password; member accounts use scrypt-hashed passwords.
- 🚫 **Spam defense on every public write** — hidden honeypot field (bots get a *fake* success and nothing is stored), minimum time-to-post, and a per-IP sliding-window rate limit. All tunable via env.
- 🔒 **XSS-safe by construction** — posts are stored as raw text and only ever served as JSON; the React client renders them as text nodes. No HTML pipeline to exploit, no sanitizer to bypass.

## Quick start

```bash
npm i
npm run build
cp .env.example .env   # set ADMIN_PASSWORD
npm start              # → http://localhost:5366
```

**Run it as a desktop app, or deploy to a $5 VPS when you need it public:**

```bash
npm run desktop        # Electron window, auto-logged-in as moderator
# or
docker compose up -d   # VPS mode, SQLite persisted in a volume
```

## Forumly vs Circle

| | **Forumly** | **Circle** |
|---|---|---|
| Price | **$39 once** | $89–$399/mo ($1,068+/yr) |
| Members | unlimited | plan-limited |
| Threads, reactions, profiles | ✅ | ✅ |
| Badges + notifications + @mentions | ✅ | ✅ |
| Moderation (pin/lock/ban) | ✅ | ✅ |
| Courses/payments/video | ❌ (it's a forum) | ✅ |
| Your data | your SQLite file | their cloud |
| Self-hosted | ✅ | ❌ |

*Circle is a full community-business suite. If what you actually need is the discussion board — the part your members open daily — Forumly pays for itself in 13 days.*

## ☕ Skip the setup — get the 1-click installer

Grab the packaged Windows installer on Whop: **https://whop.com/onetime-suite**

## Tech stack

Node 20 + Express + better-sqlite3 · React 18 + Vite + Tailwind 4 + Framer Motion + Lucide · scrypt password hashing · Electron desktop wrapper · Docker

## Tests

```bash
npm test   # boots the real server; asserts honeypot fake-success, min-time,
           # rate limit, an inert XSS attempt, notifications, mod tools & search
```

## License

MIT © 2026 Ben (bensblueprints)
