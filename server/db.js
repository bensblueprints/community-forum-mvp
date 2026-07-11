const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

function nativeBindingPath() {
  // Under Electron the Node-ABI binding won't load; use the vendored Electron prebuild.
  if (!process.versions.electron) return null;
  const p = path.join(__dirname, '..', 'vendor', 'better_sqlite3-electron.node');
  return fs.existsSync(p) ? p : null;
}

// ── password hashing (scrypt, no external deps) ──────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const nativeBinding = nativeBindingPath();
  const db = new Database(dbPath, nativeBinding ? { nativeBinding } : {});
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      avatar_path TEXT NOT NULL DEFAULT '',   -- http(s) avatar URL, or '' → generated initials
      bio TEXT NOT NULL DEFAULT '',
      banned INTEGER NOT NULL DEFAULT 0,
      digest_opt_in INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      prev_seen_at INTEGER                    -- last_seen_at from the PREVIOUS visit → "new since" marker
    );
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_post_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      parent_post_id INTEGER,                 -- one-level nesting: parent must be a top-level post
      body_html TEXT NOT NULL,                -- SAFE: raw author text (markdown-lite). Never rendered as HTML —
                                              -- the client renders it as text nodes only. Name kept from the spec.
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(post_id, member_id, emoji)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,             -- recipient
      type TEXT NOT NULL,                     -- 'reply' | 'mention'
      ref_id INTEGER NOT NULL,                -- post id
      read INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🏅',
      awarded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      member_id INTEGER,                      -- NULL for moderator (admin) sessions
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_threads_cat ON threads(category_id, pinned, last_post_at);
    CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications(member_id, read, at);
  `);

  // seed starter categories on first run
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count === 0) {
    const now = Date.now();
    const ins = db.prepare('INSERT INTO categories (name, description, sort_order, created_at) VALUES (?, ?, ?, ?)');
    ins.run('General', 'Anything and everything — say hi.', 0, now);
    ins.run('Introductions', 'New here? Introduce yourself to the community.', 1, now);
    ins.run('Feedback & Ideas', 'Suggestions, feature requests and honest feedback.', 2, now);
  }

  return db;
}

const DEFAULT_SETTINGS = {
  forum_name: 'Forumly',
  digest_enabled: '0',   // email digest is a stub setting — no real email is sent
  digest_frequency: 'weekly'
};

function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.value !== '' && r.value != null) out[r.key] = r.value;
  }
  return out;
}

function setSettings(db, obj) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (k in DEFAULT_SETTINGS) stmt.run(k, String(v ?? ''));
    }
  });
  tx(Object.entries(obj));
}

module.exports = { openDb, hashPassword, verifyPassword, getSettings, setSettings, DEFAULT_SETTINGS };
