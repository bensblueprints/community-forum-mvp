# Product Hunt — Forumly

**Name:** Forumly

**Tagline (60 chars):** A community forum you own. $39 once — not Circle's $89/mo.

**Description (260 chars):**
Forumly is a self-hosted forum: categories, threads, nested replies, emoji reactions, profiles with badges, @mentions, notifications, search, and real mod tools (pin/lock/ban). Spam-proofed with honeypots + rate limits. SQLite, Docker, MIT. Pay once.

**Full description:**
Communities ran on forums for decades before "community platforms" started charging $89–399/month for the privilege. Forumly is the forum part — the part members actually open — as a product you own:

- Categories → threads → one-level nested replies, with pinning, locking, and "new since your last visit" dots.
- Emoji reactions, member profiles (avatar, bio, post count), and a manual badge system for recognizing your regulars.
- Reply and @mention notifications behind an unread bell. Search across titles and bodies.
- Moderator tools that actually moderate: edit/delete anything, ban members, manage categories — behind a separate admin login.
- Spam defense on every public write: a honeypot field (bots get a fake success and nothing hits the database), minimum time-to-post, and a per-IP rate limit.
- Security worth bragging about: posts are stored as raw text and only ever served as JSON — the client renders text nodes, so there is no HTML pipeline for stored XSS to live in.

One process, one SQLite file, Docker compose for a $5 VPS, or run it as a desktop app. MIT source.

**Maker first comment:**
Hi PH 👋 I got tired of paying $89/mo for what is, functionally, phpBB with better fonts. Circle and friends are great if you need courses + payments + video — but most communities need a place to talk, and that problem was solved in 2003.

Forumly is my modern take: React front-end, SQLite storage, honeypot + min-time + rate-limit spam defense (the honeypot returns a fake success so bots never learn), and a rendering model where user content is never HTML — the smoke test literally posts a <script> payload and asserts it stays inert everywhere. MIT source; the paid product is a 1-click installer. Happy to talk spam defense or the economics of community SaaS.

**Gallery shots (5):**
1. Home — category cards with thread counts and "new" dots.
2. Thread view — nested replies, emoji reactions, pinned + locked badges.
3. Notification bell dropdown — "@bob mentioned you in Welcome thread".
4. Member profile — avatar, bio, badges, recent posts.
5. Moderator view — pin/lock/delete controls and a ban button.
