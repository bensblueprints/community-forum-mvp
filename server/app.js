// Forumly — Express app factory. Single process serves the JSON API + built SPA.
//
// SECURITY MODEL (Chatterbox-grade):
//  * User content is stored as raw text and ONLY ever returned inside JSON.
//    The React client renders it as text nodes — no dangerouslySetInnerHTML,
//    no server-side HTML rendering, so <script>/onerror payloads stay inert.
//  * Spam defense on every public write: honeypot hidden field (bots get a fake
//    success and nothing is stored), minimum-time-to-post, per-IP sliding-window
//    rate limit.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { openDb, hashPassword, verifyPassword, getSettings, setSettings } = require('./db');

const SESSION_COOKIE = 'forumly_sid';
const EMOJIS = new Set(['👍', '❤️', '😂', '🎉', '🤔', '🔥']);
const NAME_RE = /^[A-Za-z0-9_.\-]{2,32}$/; // mentionable names: @word chars only
const MAX_BODY = 20000;
const MAX_TITLE = 200;

function createApp(opts = {}) {
  const dbPath = opts.dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'forumly.db');
  const adminPassword = opts.adminPassword || process.env.ADMIN_PASSWORD || 'admin';
  const autologinToken = opts.autologinToken || process.env.AUTOLOGIN_TOKEN || null;
  const rateLimitMax = Number(opts.rateLimitMax ?? process.env.RATE_LIMIT_MAX ?? 10);
  const rateLimitWindowMs = Number(opts.rateLimitWindowMs ?? process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  const minPostMs = Number(opts.minPostMs ?? process.env.MIN_POST_MS ?? 2000);

  const db = openDb(dbPath);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.locals.db = db;

  // ── sessions ────────────────────────────────────────────────────────────────
  function newSession(res, { memberId = null, isAdmin = 0 } = {}) {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, member_id, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(token, memberId, isAdmin, Date.now());
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    return token;
  }
  function getSession(req) {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return null;
    return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) || null;
  }
  function currentMember(req) {
    const s = getSession(req);
    if (!s || !s.member_id) return null;
    return db.prepare('SELECT * FROM members WHERE id = ?').get(s.member_id) || null;
  }
  function isModerator(req) {
    const s = getSession(req);
    return !!(s && s.is_admin);
  }
  function requireMember(req, res, next) {
    const m = currentMember(req);
    if (!m) return res.status(401).json({ error: 'Sign in to do that' });
    req.member = m;
    next();
  }
  function requireMod(req, res, next) {
    if (!isModerator(req)) return res.status(401).json({ error: 'Moderator access required' });
    next();
  }

  // ── spam defense (Chatterbox-grade) ─────────────────────────────────────────
  function getIp(req) {
    return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || req.socket.remoteAddress || '?';
  }
  const hits = new Map(); // bucket key -> [timestamps]
  function rateLimited(key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < rateLimitWindowMs);
    if (arr.length >= rateLimitMax) { hits.set(key, arr); return true; }
    arr.push(now);
    hits.set(key, arr);
    return false;
  }
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const live = arr.filter((t) => now - t < rateLimitWindowMs);
      if (live.length) hits.set(k, live); else hits.delete(k);
    }
  }, 5 * 60_000);
  sweeper.unref();

  // Returns 'bot' | 'limited' | 'fast' | null. Honeypot bots skip the rate
  // limiter and get a fake success upstream — never tip them off.
  function spamCheck(req, bucket, { checkSpeed = true } = {}) {
    const b = req.body || {};
    if (typeof b.hp === 'string' && b.hp.trim() !== '') return 'bot';
    if (rateLimited(`${getIp(req)}:${bucket}`)) return 'limited';
    if (checkSpeed) {
      const elapsed = Number(b.elapsed_ms);
      if (!Number.isFinite(elapsed) || elapsed < minPostMs) return 'fast';
    }
    return null;
  }
  function rejectSpam(res, verdict) {
    // fake success for honeypot bots (nothing was stored)
    if (verdict === 'bot') { res.status(201).json({ ok: true, id: 0 }); return true; }
    if (verdict === 'limited') { res.status(429).json({ error: 'Too many posts — slow down' }); return true; }
    if (verdict === 'fast') { res.status(400).json({ error: 'Posted too quickly — are you human?' }); return true; }
    return false;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  function cleanBody(raw) {
    return String(raw || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY);
  }
  function publicMember(m) {
    if (!m) return null;
    const { password_hash, email, prev_seen_at, ...safe } = m;
    return safe;
  }
  function memberSummary(id) {
    const m = db.prepare('SELECT id, name, avatar_path, banned FROM members WHERE id = ?').get(id);
    return m || { id, name: '[deleted]', avatar_path: '', banned: 0 };
  }
  function notify(memberId, type, refId) {
    db.prepare('INSERT INTO notifications (member_id, type, ref_id, read, at) VALUES (?, ?, ?, 0, ?)')
      .run(memberId, type, refId, Date.now());
  }
  // @mention → notification for each mentioned member (except the author).
  function processMentions(body, postId, authorId, alsoSkip = []) {
    const seen = new Set([authorId, ...alsoSkip]);
    for (const match of String(body).matchAll(/@([A-Za-z0-9_.\-]{2,32})/g)) {
      const m = db.prepare('SELECT id FROM members WHERE name = ? COLLATE NOCASE').get(match[1]);
      if (m && !seen.has(m.id)) {
        seen.add(m.id);
        notify(m.id, 'mention', postId);
      }
    }
  }
  function reactionsFor(postIds, memberId) {
    if (!postIds.length) return {};
    const qs = postIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT post_id, emoji, COUNT(*) AS count,
              MAX(CASE WHEN member_id = ? THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE post_id IN (${qs}) GROUP BY post_id, emoji`
    ).all(memberId || -1, ...postIds);
    const map = {};
    for (const r of rows) {
      (map[r.post_id] ||= []).push({ emoji: r.emoji, count: r.count, mine: !!r.mine });
    }
    return map;
  }
  function threadSummary(t, member) {
    const replyCount = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE thread_id = ? AND deleted = 0').get(t.id).n;
    return {
      ...t,
      author: memberSummary(t.author_id),
      reply_count: Math.max(0, replyCount - 1), // first post is the thread body
      is_new: !!(member && member.prev_seen_at && t.last_post_at > member.prev_seen_at)
    };
  }

  // ── health ──────────────────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => res.json({ ok: true, app: 'forumly' }));

  // ── member auth ─────────────────────────────────────────────────────────────
  app.post('/api/register', (req, res) => {
    const verdict = spamCheck(req, 'register', { checkSpeed: false });
    if (verdict === 'bot') { res.status(201).json({ ok: true }); return; } // fake success, nothing stored
    if (rejectSpam(res, verdict)) return;

    const b = req.body || {};
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Name must be 2-32 chars: letters, numbers, . _ -' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const clash = db.prepare('SELECT id FROM members WHERE name = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(name, email);
    if (clash) return res.status(409).json({ error: 'Name or email already taken' });

    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO members (name, email, password_hash, joined_at, last_seen_at, prev_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, email, hashPassword(password), now, now, now);
    newSession(res, { memberId: info.lastInsertRowid });
    res.status(201).json({ ok: true, member: publicMember(db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid)) });
  });

  app.post('/api/login', (req, res) => {
    const b = req.body || {};
    const m = db.prepare('SELECT * FROM members WHERE email = ? COLLATE NOCASE').get(String(b.email || '').trim());
    if (!m || !verifyPassword(b.password, m.password_hash)) {
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    // roll the "seen" window: what was last_seen becomes the "new since" marker
    const now = Date.now();
    db.prepare('UPDATE members SET prev_seen_at = last_seen_at, last_seen_at = ? WHERE id = ?').run(now, m.id);
    newSession(res, { memberId: m.id });
    res.json({ ok: true, member: publicMember(db.prepare('SELECT * FROM members WHERE id = ?').get(m.id)) });
  });

  app.post('/api/logout', (req, res) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    const m = currentMember(req);
    const mod = isModerator(req);
    let unread = 0;
    if (m) {
      unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE member_id = ? AND read = 0').get(m.id).n;
      db.prepare('UPDATE members SET last_seen_at = ? WHERE id = ?').run(Date.now(), m.id);
    }
    res.json({
      member: m ? { ...publicMember(m), email: m.email, prev_seen_at: m.prev_seen_at, digest_opt_in: m.digest_opt_in } : null,
      moderator: mod,
      unread
    });
  });

  // ── moderator auth ──────────────────────────────────────────────────────────
  app.post('/api/admin/login', (req, res) => {
    if (String((req.body || {}).password || '') !== adminPassword) {
      return res.status(401).json({ error: 'Wrong password' });
    }
    newSession(res, { isAdmin: 1 });
    res.json({ ok: true });
  });

  // desktop mode auto-login (Electron passes a one-shot token)
  app.get('/auth/auto', (req, res) => {
    if (autologinToken && req.query.token === autologinToken) newSession(res, { isAdmin: 1 });
    res.redirect('/');
  });

  // ── categories ──────────────────────────────────────────────────────────────
  app.get('/api/categories', (req, res) => {
    const member = currentMember(req);
    const cats = db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all();
    res.json(cats.map((c) => {
      const threadCount = db.prepare('SELECT COUNT(*) AS n FROM threads WHERE category_id = ?').get(c.id).n;
      const postCount = db.prepare(
        'SELECT COUNT(*) AS n FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.category_id = ? AND p.deleted = 0'
      ).get(c.id).n;
      const latest = db.prepare('SELECT * FROM threads WHERE category_id = ? ORDER BY last_post_at DESC LIMIT 1').get(c.id);
      const hasNew = !!(member && member.prev_seen_at && db.prepare(
        'SELECT 1 FROM threads WHERE category_id = ? AND last_post_at > ? LIMIT 1'
      ).get(c.id, member.prev_seen_at));
      return {
        ...c,
        thread_count: threadCount,
        post_count: postCount,
        latest_thread: latest ? { id: latest.id, title: latest.title, last_post_at: latest.last_post_at, author: memberSummary(latest.author_id) } : null,
        has_new: hasNew
      };
    }));
  });

  app.post('/api/categories', requireMod, (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const description = String((req.body || {}).description || '').trim().slice(0, 300);
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories').get().m;
    const info = db.prepare('INSERT INTO categories (name, description, sort_order, created_at) VALUES (?, ?, ?, ?)')
      .run(name, description, maxOrder + 1, Date.now());
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  });

  app.put('/api/categories/:id', requireMod, (req, res) => {
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    db.prepare('UPDATE categories SET name = ?, description = ?, sort_order = ? WHERE id = ?').run(
      String(b.name ?? c.name).trim().slice(0, 80) || c.name,
      String(b.description ?? c.description).trim().slice(0, 300),
      Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : c.sort_order,
      c.id
    );
    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(c.id));
  });

  app.delete('/api/categories/:id', requireMod, (req, res) => {
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const tx = db.transaction(() => {
      const threadIds = db.prepare('SELECT id FROM threads WHERE category_id = ?').all(c.id).map((t) => t.id);
      for (const tid of threadIds) {
        db.prepare('DELETE FROM reactions WHERE post_id IN (SELECT id FROM posts WHERE thread_id = ?)').run(tid);
        db.prepare('DELETE FROM posts WHERE thread_id = ?').run(tid);
      }
      db.prepare('DELETE FROM threads WHERE category_id = ?').run(c.id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
    });
    tx();
    res.json({ ok: true });
  });

  // ── threads ─────────────────────────────────────────────────────────────────
  app.get('/api/categories/:id/threads', (req, res) => {
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const member = currentMember(req);
    const threads = db.prepare(
      'SELECT * FROM threads WHERE category_id = ? ORDER BY pinned DESC, last_post_at DESC'
    ).all(c.id);
    res.json({ category: c, threads: threads.map((t) => threadSummary(t, member)) });
  });

  app.post('/api/threads', requireMember, (req, res) => {
    const verdict = spamCheck(req, 'post');
    if (rejectSpam(res, verdict)) return;
    if (req.member.banned) return res.status(403).json({ error: 'Your account is banned' });

    const b = req.body || {};
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(b.category_id));
    if (!category) return res.status(400).json({ error: 'Unknown category' });
    const title = String(b.title || '').trim().slice(0, MAX_TITLE);
    const body = cleanBody(b.body);
    if (!title) return res.status(400).json({ error: 'Title required' });
    if (!body) return res.status(400).json({ error: 'Body required' });

    const now = Date.now();
    const tx = db.transaction(() => {
      const tInfo = db.prepare(
        'INSERT INTO threads (category_id, title, author_id, pinned, locked, created_at, last_post_at) VALUES (?, ?, ?, 0, 0, ?, ?)'
      ).run(category.id, title, req.member.id, now, now);
      const pInfo = db.prepare(
        'INSERT INTO posts (thread_id, author_id, parent_post_id, body_html, created_at) VALUES (?, ?, NULL, ?, ?)'
      ).run(tInfo.lastInsertRowid, req.member.id, body, now);
      return { threadId: tInfo.lastInsertRowid, postId: pInfo.lastInsertRowid };
    });
    const { threadId, postId } = tx();
    processMentions(body, postId, req.member.id);
    res.status(201).json({ ok: true, id: threadId, post_id: postId });
  });

  app.get('/api/threads/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const member = currentMember(req);
    const posts = db.prepare('SELECT * FROM posts WHERE thread_id = ? ORDER BY created_at, id').all(t.id);
    const rmap = reactionsFor(posts.map((p) => p.id), member?.id);
    res.json({
      thread: { ...t, author: memberSummary(t.author_id), category: db.prepare('SELECT * FROM categories WHERE id = ?').get(t.category_id) },
      posts: posts.map((p) => ({
        ...p,
        body_html: p.deleted ? '' : p.body_html,
        author: memberSummary(p.author_id),
        reactions: rmap[p.id] || []
      }))
    });
  });

  app.post('/api/threads/:id/posts', requireMember, (req, res) => {
    const verdict = spamCheck(req, 'post');
    if (rejectSpam(res, verdict)) return;
    const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Thread not found' });
    if (req.member.banned) return res.status(403).json({ error: 'Your account is banned' });
    if (t.locked) return res.status(403).json({ error: 'Thread is locked' });

    const b = req.body || {};
    const body = cleanBody(b.body);
    if (!body) return res.status(400).json({ error: 'Body required' });

    // one-level nesting: a reply's parent must be a top-level post in this thread
    let parentId = b.parent_post_id ? Number(b.parent_post_id) : null;
    let parentAuthorId = null;
    if (parentId) {
      const parent = db.prepare('SELECT * FROM posts WHERE id = ? AND thread_id = ?').get(parentId, t.id);
      if (!parent) return res.status(400).json({ error: 'Unknown parent post' });
      if (parent.parent_post_id) parentId = parent.parent_post_id; // flatten to one level
      parentAuthorId = parent.author_id;
    }

    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO posts (thread_id, author_id, parent_post_id, body_html, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(t.id, req.member.id, parentId, body, now);
    db.prepare('UPDATE threads SET last_post_at = ? WHERE id = ?').run(now, t.id);

    const notified = [];
    if (t.author_id !== req.member.id) {
      notify(t.author_id, 'reply', info.lastInsertRowid);
      notified.push(t.author_id);
    }
    if (parentAuthorId && parentAuthorId !== req.member.id && !notified.includes(parentAuthorId)) {
      notify(parentAuthorId, 'reply', info.lastInsertRowid);
      notified.push(parentAuthorId);
    }
    processMentions(body, info.lastInsertRowid, req.member.id, notified);
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  });

  // edit / delete — author or moderator
  app.put('/api/posts/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!p || p.deleted) return res.status(404).json({ error: 'Not found' });
    const member = currentMember(req);
    const mod = isModerator(req);
    if (!mod && (!member || member.id !== p.author_id)) return res.status(403).json({ error: 'Not your post' });
    if (!mod && member.banned) return res.status(403).json({ error: 'Your account is banned' });
    const body = cleanBody((req.body || {}).body);
    if (!body) return res.status(400).json({ error: 'Body required' });
    db.prepare('UPDATE posts SET body_html = ?, edited_at = ? WHERE id = ?').run(body, Date.now(), p.id);
    res.json({ ok: true, ...db.prepare('SELECT * FROM posts WHERE id = ?').get(p.id) });
  });

  app.delete('/api/posts/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const member = currentMember(req);
    const mod = isModerator(req);
    if (!mod && (!member || member.id !== p.author_id)) return res.status(403).json({ error: 'Not your post' });
    db.prepare("UPDATE posts SET deleted = 1, body_html = '' WHERE id = ?").run(p.id);
    res.json({ ok: true });
  });

  // ── reactions (toggle) ──────────────────────────────────────────────────────
  app.post('/api/posts/:id/react', requireMember, (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted = 0').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (req.member.banned) return res.status(403).json({ error: 'Your account is banned' });
    const emoji = String((req.body || {}).emoji || '');
    if (!EMOJIS.has(emoji)) return res.status(400).json({ error: 'Unsupported emoji' });
    const existing = db.prepare('SELECT id FROM reactions WHERE post_id = ? AND member_id = ? AND emoji = ?')
      .get(p.id, req.member.id, emoji);
    if (existing) db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
    else db.prepare('INSERT INTO reactions (post_id, member_id, emoji, created_at) VALUES (?, ?, ?, ?)')
      .run(p.id, req.member.id, emoji, Date.now());
    res.json({ ok: true, reactions: reactionsFor([p.id], req.member.id)[p.id] || [] });
  });

  // ── moderator tools ─────────────────────────────────────────────────────────
  app.post('/api/threads/:id/pin', requireMod, (req, res) => {
    const info = db.prepare('UPDATE threads SET pinned = ? WHERE id = ?')
      .run((req.body || {}).pinned ? 1 : 0, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json(db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id));
  });

  app.post('/api/threads/:id/lock', requireMod, (req, res) => {
    const info = db.prepare('UPDATE threads SET locked = ? WHERE id = ?')
      .run((req.body || {}).locked ? 1 : 0, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json(db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/threads/:id', requireMod, (req, res) => {
    const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM reactions WHERE post_id IN (SELECT id FROM posts WHERE thread_id = ?)').run(t.id);
      db.prepare('DELETE FROM posts WHERE thread_id = ?').run(t.id);
      db.prepare('DELETE FROM threads WHERE id = ?').run(t.id);
    });
    tx();
    res.json({ ok: true });
  });

  app.post('/api/members/:id/ban', requireMod, (req, res) => {
    const info = db.prepare('UPDATE members SET banned = ? WHERE id = ?')
      .run((req.body || {}).banned ? 1 : 0, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json(publicMember(db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id)));
  });

  // ── badges (manual award) ───────────────────────────────────────────────────
  app.post('/api/members/:id/badges', requireMod, (req, res) => {
    const m = db.prepare('SELECT id FROM members WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const label = String((req.body || {}).label || '').trim().slice(0, 60);
    if (!label) return res.status(400).json({ error: 'Label required' });
    const icon = String((req.body || {}).icon || '🏅').trim().slice(0, 8) || '🏅';
    const info = db.prepare('INSERT INTO badges (member_id, label, icon, awarded_at) VALUES (?, ?, ?, ?)')
      .run(m.id, label, icon, Date.now());
    res.status(201).json(db.prepare('SELECT * FROM badges WHERE id = ?').get(info.lastInsertRowid));
  });

  app.delete('/api/badges/:id', requireMod, (req, res) => {
    const info = db.prepare('DELETE FROM badges WHERE id = ?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ── profiles ────────────────────────────────────────────────────────────────
  app.get('/api/members/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const postCount = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_id = ? AND deleted = 0').get(m.id).n;
    const badges = db.prepare('SELECT * FROM badges WHERE member_id = ? ORDER BY awarded_at DESC').all(m.id);
    const recent = db.prepare(
      `SELECT p.id, p.thread_id, p.body_html, p.created_at, t.title AS thread_title
       FROM posts p JOIN threads t ON t.id = p.thread_id
       WHERE p.author_id = ? AND p.deleted = 0 ORDER BY p.created_at DESC LIMIT 10`
    ).all(m.id);
    res.json({ member: publicMember(m), post_count: postCount, badges, recent_posts: recent });
  });

  app.put('/api/profile', requireMember, (req, res) => {
    const b = req.body || {};
    let avatar = String(b.avatar_path ?? req.member.avatar_path).trim().slice(0, 500);
    if (avatar && !/^https?:\/\//i.test(avatar)) avatar = ''; // URL avatars only — anything else → initials
    db.prepare('UPDATE members SET bio = ?, avatar_path = ?, digest_opt_in = ? WHERE id = ?').run(
      String(b.bio ?? req.member.bio).trim().slice(0, 500),
      avatar,
      b.digest_opt_in != null ? (b.digest_opt_in ? 1 : 0) : req.member.digest_opt_in,
      req.member.id
    );
    res.json(publicMember(db.prepare('SELECT * FROM members WHERE id = ?').get(req.member.id)));
  });

  // ── notifications ───────────────────────────────────────────────────────────
  app.get('/api/notifications', requireMember, (req, res) => {
    const rows = db.prepare(
      `SELECT n.*, p.thread_id, p.author_id AS actor_id, t.title AS thread_title
       FROM notifications n
       LEFT JOIN posts p ON p.id = n.ref_id
       LEFT JOIN threads t ON t.id = p.thread_id
       WHERE n.member_id = ? ORDER BY n.at DESC LIMIT 50`
    ).all(req.member.id);
    res.json(rows.map((r) => ({ ...r, actor: r.actor_id ? memberSummary(r.actor_id) : null })));
  });

  app.post('/api/notifications/read', requireMember, (req, res) => {
    const ids = (req.body || {}).ids;
    if (Array.isArray(ids) && ids.length) {
      const stmt = db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND member_id = ?');
      const tx = db.transaction((list) => { for (const id of list) stmt.run(id, req.member.id); });
      tx(ids);
    } else {
      db.prepare('UPDATE notifications SET read = 1 WHERE member_id = ?').run(req.member.id);
    }
    res.json({ ok: true });
  });

  // ── search ──────────────────────────────────────────────────────────────────
  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.json({ q, results: [] });
    const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
    const member = currentMember(req);
    const rows = db.prepare(
      `SELECT DISTINCT t.* FROM threads t
       LEFT JOIN posts p ON p.thread_id = t.id AND p.deleted = 0
       WHERE t.title LIKE ? ESCAPE '\\' OR p.body_html LIKE ? ESCAPE '\\'
       ORDER BY t.last_post_at DESC LIMIT 50`
    ).all(like, like);
    res.json({
      q,
      results: rows.map((t) => {
        const snippetRow = db.prepare(
          `SELECT body_html FROM posts WHERE thread_id = ? AND deleted = 0 AND body_html LIKE ? ESCAPE '\\' LIMIT 1`
        ).get(t.id, like);
        let snippet = '';
        if (snippetRow) {
          const idx = snippetRow.body_html.toLowerCase().indexOf(q.toLowerCase());
          snippet = snippetRow.body_html.slice(Math.max(0, idx - 60), idx + 90);
        }
        return { ...threadSummary(t, member), snippet };
      })
    });
  });

  // ── admin settings (email digest is a stub — no real email is sent) ────────
  app.get('/api/admin/settings', requireMod, (req, res) => res.json(getSettings(db)));
  app.put('/api/admin/settings', requireMod, (req, res) => {
    setSettings(db, req.body || {});
    res.json(getSettings(db));
  });

  // ── static frontend (SPA) ───────────────────────────────────────────────────
  const dist = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  return app;
}

module.exports = { createApp };
