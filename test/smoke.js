// Forumly smoke test — boots the real server on a temp DB and exercises the
// full forum pipeline: register → threads → replies (one-level nesting) →
// reactions → notifications (reply + @mention) → moderator tools (pin, lock,
// ban, delete, badges) → search → and the spam defenses:
//   * honeypot: bots get a FAKE success and nothing is stored
//   * minimum time-to-post
//   * per-IP rate limit
//   * XSS attempt asserted inert: stored as raw text, returned only in JSON,
//     never present in any server-rendered HTML.
// Kills ONLY the spawned server child.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 5467; // offset port — other build agents run concurrently
const ADMIN_PASSWORD = 'smoke-test-password';
const DB_PATH = path.join(__dirname, 'smoke.db');
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const XSS = '<script>window.__pwned=1</script><img src=x onerror=alert(1)>';
const OK_MS = 5000; // safely above MIN_POST_MS

for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

let serverProc = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, tries = 40, delay = 250) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(delay);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function makeClient() {
  let cookie = '';
  return async function api(pathname, options = {}) {
    const res = await fetch(BASE + pathname, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

async function main() {
  console.log('1. Booting Forumly on port', TEST_PORT, '(MIN_POST_MS=300, RATE_LIMIT_MAX=8)');
  serverProc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ADMIN_PASSWORD,
      DB_PATH,
      MIN_POST_MS: '300',
      RATE_LIMIT_MAX: '8',
      RATE_LIMIT_WINDOW_MS: '60000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', (d) => process.stdout.write(`   [server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`   [server] ${d}`));

  const alice = makeClient();
  const bob = makeClient();
  const mod = makeClient();
  const anon = makeClient();

  await waitFor(async () => (await anon('/api/health')).data.ok, 'server health');

  console.log('2. Seeded categories exist; anonymous can read, cannot post');
  const cats = (await anon('/api/categories')).data;
  assert.ok(cats.length >= 3, 'starter categories must be seeded');
  const general = cats.find((c) => c.name === 'General');
  assert.ok(general);
  const anonPost = await anon('/api/threads', {
    method: 'POST', body: { category_id: general.id, title: 'x', body: 'y', elapsed_ms: OK_MS }
  });
  assert.strictEqual(anonPost.status, 401, 'anonymous posting must 401');

  console.log('3. Honeypot on REGISTER: filled hp → fake success, nothing stored');
  const botReg = await anon('/api/register', {
    method: 'POST',
    body: { name: 'spambot', email: 'bot@spam.example', password: 'botbotbot', hp: 'http://spam.example' }
  });
  assert.strictEqual(botReg.status, 201, 'honeypot must return a FAKE success');
  const botLogin = await anon('/api/login', { method: 'POST', body: { email: 'bot@spam.example', password: 'botbotbot' } });
  assert.strictEqual(botLogin.status, 401, 'honeypotted registration must not exist');

  console.log('4. Real members register: alice + bob');
  const regA = await alice('/api/register', {
    method: 'POST', body: { name: 'alice', email: 'alice@example.com', password: 'hunter22', hp: '' }
  });
  assert.strictEqual(regA.status, 201);
  assert.ok(regA.data.member.id);
  assert.strictEqual(regA.data.member.password_hash, undefined, 'password hash must never be returned');
  assert.strictEqual(regA.data.member.email, undefined, 'email must not leak in public member payloads');
  const regB = await bob('/api/register', {
    method: 'POST', body: { name: 'bob', email: 'bob@example.com', password: 'hunter22', hp: '' }
  });
  assert.strictEqual(regB.status, 201);
  const aliceId = regA.data.member.id;
  const bobId = regB.data.member.id;

  console.log('5. Min-time-to-post: instant submit → 400 "too quickly"');
  const fast = await alice('/api/threads', {
    method: 'POST', body: { category_id: general.id, title: 'Fast', body: 'zoom', hp: '', elapsed_ms: 10 }
  });
  assert.strictEqual(fast.status, 400);
  assert.ok(fast.data.error.includes('quickly'), 'must reject too-fast posts');

  console.log('6. Alice creates a thread containing an XSS attempt');
  const created = await alice('/api/threads', {
    method: 'POST',
    body: { category_id: general.id, title: `Hello ${XSS}`, body: `First post! ${XSS} @bob`, hp: '', elapsed_ms: OK_MS }
  });
  assert.strictEqual(created.status, 201);
  const threadId = created.data.id;

  console.log('7. XSS inert: payload only ever appears as JSON data, NEVER in HTML');
  const threadJson = await anon(`/api/threads/${threadId}`);
  assert.ok(threadJson.headers.get('content-type').includes('application/json'), 'thread content is JSON-only');
  assert.ok(threadJson.data.posts[0].body_html.includes('<script>'), 'raw text stored verbatim as data');
  const shellRes = await fetch(`${BASE}/`);
  const shellHtml = await shellRes.text();
  assert.ok(!shellHtml.includes('__pwned'), 'SPA shell must not contain the payload');
  const threadPage = await fetch(`${BASE}/thread/${threadId}`);
  const threadPageHtml = await threadPage.text();
  assert.ok(!threadPageHtml.includes('__pwned'), 'server-rendered HTML must never contain user content');
  assert.ok(!threadPageHtml.includes('onerror=alert'), 'attack markup absent from all HTML responses');
  // (client renders body text via React text nodes only — no dangerouslySetInnerHTML in client/src)
  const clientSrc = fs.readdirSync(path.join(ROOT, 'client', 'src'), { recursive: true })
    .filter((f) => String(f).endsWith('.jsx') || String(f).endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'client', 'src', String(f)), 'utf8'))
    .join('\n');
  assert.ok(!clientSrc.includes('dangerouslySetInnerHTML'), 'client must not use dangerouslySetInnerHTML');

  console.log('8. @mention in the first post notified bob');
  const bobMe = await bob('/api/me');
  assert.strictEqual(bobMe.data.unread, 1, 'bob must have exactly 1 unread (the @mention)');
  const bobNotifs = (await bob('/api/notifications')).data;
  assert.strictEqual(bobNotifs[0].type, 'mention');
  assert.strictEqual(bobNotifs[0].actor.name, 'alice');

  console.log('9. Bob replies (notifies alice); nested reply flattens to one level');
  const reply = await bob(`/api/threads/${threadId}/posts`, {
    method: 'POST', body: { body: 'Welcome alice!', hp: '', elapsed_ms: OK_MS }
  });
  assert.strictEqual(reply.status, 201);
  const nested = await alice(`/api/threads/${threadId}/posts`, {
    method: 'POST', body: { body: 'Thanks bob!', parent_post_id: reply.data.id, hp: '', elapsed_ms: OK_MS }
  });
  assert.strictEqual(nested.status, 201);
  const t2 = (await anon(`/api/threads/${threadId}`)).data;
  assert.strictEqual(t2.posts.length, 3);
  const nestedPost = t2.posts.find((p) => p.id === nested.data.id);
  assert.strictEqual(nestedPost.parent_post_id, reply.data.id, 'reply nests one level under bob\'s post');
  const aliceUnread = (await alice('/api/me')).data.unread;
  assert.strictEqual(aliceUnread, 1, 'alice must be notified of bob\'s reply (not her own)');

  console.log('10. Reactions: toggle on, counts, toggle off');
  const r1 = await bob(`/api/posts/${created.data.post_id}/react`, { method: 'POST', body: { emoji: '👍' } });
  assert.deepStrictEqual(r1.data.reactions, [{ emoji: '👍', count: 1, mine: true }]);
  await alice(`/api/posts/${created.data.post_id}/react`, { method: 'POST', body: { emoji: '👍' } });
  const t3 = (await bob(`/api/threads/${threadId}`)).data;
  assert.strictEqual(t3.posts[0].reactions[0].count, 2, 'two members reacted 👍');
  const r2 = await bob(`/api/posts/${created.data.post_id}/react`, { method: 'POST', body: { emoji: '👍' } });
  assert.strictEqual((r2.data.reactions[0]?.count || 0), 1, 'toggle off must decrement');
  const badEmoji = await bob(`/api/posts/${created.data.post_id}/react`, { method: 'POST', body: { emoji: '<script>' } });
  assert.strictEqual(badEmoji.status, 400, 'only allow-listed emojis accepted');

  console.log('11. Moderator: login, pin, lock (members blocked), ban bob (posting blocked)');
  assert.strictEqual((await mod('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  assert.strictEqual((await mod('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })).status, 200);
  assert.strictEqual((await alice(`/api/threads/${threadId}/pin`, { method: 'POST', body: { pinned: 1 } })).status, 401, 'members cannot pin');
  const pinned = await mod(`/api/threads/${threadId}/pin`, { method: 'POST', body: { pinned: 1 } });
  assert.strictEqual(pinned.data.pinned, 1);
  await mod(`/api/threads/${threadId}/lock`, { method: 'POST', body: { locked: 1 } });
  const lockedReply = await bob(`/api/threads/${threadId}/posts`, {
    method: 'POST', body: { body: 'sneaky', hp: '', elapsed_ms: OK_MS }
  });
  assert.strictEqual(lockedReply.status, 403, 'locked thread must reject replies');
  await mod(`/api/threads/${threadId}/lock`, { method: 'POST', body: { locked: 0 } });

  await mod(`/api/members/${bobId}/ban`, { method: 'POST', body: { banned: 1 } });
  const bannedPost = await bob(`/api/threads/${threadId}/posts`, {
    method: 'POST', body: { body: 'let me in', hp: '', elapsed_ms: OK_MS }
  });
  assert.strictEqual(bannedPost.status, 403, 'banned member must not post');
  await mod(`/api/members/${bobId}/ban`, { method: 'POST', body: { banned: 0 } });

  console.log('12. Moderator deletes a post; badge award shows on profile');
  await mod(`/api/posts/${nested.data.id}`, { method: 'DELETE' });
  const t4 = (await anon(`/api/threads/${threadId}`)).data;
  const deleted = t4.posts.find((p) => p.id === nested.data.id);
  assert.strictEqual(deleted.deleted, 1);
  assert.strictEqual(deleted.body_html, '', 'deleted post body must be blanked');
  await mod(`/api/members/${aliceId}/badges`, { method: 'POST', body: { label: 'Founding member', icon: '🌟' } });
  const profile = (await anon(`/api/members/${aliceId}`)).data;
  assert.strictEqual(profile.badges[0].label, 'Founding member');
  assert.strictEqual(profile.member.email, undefined, 'profile must not leak email');
  assert.ok(profile.post_count >= 1);

  console.log('13. Honeypot on POST: filled hp → fake 201, nothing stored');
  const before = (await anon(`/api/threads/${threadId}`)).data.posts.length;
  const botPost = await bob(`/api/threads/${threadId}/posts`, {
    method: 'POST', body: { body: 'BUY PILLS', hp: 'gotcha', elapsed_ms: OK_MS }
  });
  assert.strictEqual(botPost.status, 201, 'bot must see a fake success');
  assert.strictEqual(botPost.data.id, 0, 'fake id');
  const after = (await anon(`/api/threads/${threadId}`)).data.posts.length;
  assert.strictEqual(after, before, 'honeypotted post must NOT be stored');

  console.log('14. Search finds the thread by body text');
  const search = (await anon('/api/search?q=Welcome')).data;
  assert.ok(search.results.some((t) => t.id === threadId), 'search must find bob\'s reply text');
  assert.strictEqual((await anon('/api/search?q=BUY%20PILLS')).data.results.length, 0, 'honeypotted content is unsearchable (never stored)');

  console.log('15. Rate limit: rapid-fire posting hits 429');
  let last = null;
  for (let i = 0; i < 12; i++) {
    last = await alice(`/api/threads/${threadId}/posts`, {
      method: 'POST', body: { body: `flood ${i}`, hp: '', elapsed_ms: OK_MS }
    });
    if (last.status === 429) break;
  }
  assert.strictEqual(last.status, 429, 'rapid posting must be rate limited');

  console.log('16. Rows persisted in SQLite');
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM members').get().n, 2, 'only alice + bob (no bot)');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM posts').get().n >= 3);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM posts WHERE body_html LIKE '%BUY PILLS%'").get().n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM badges').get().n, 1);
  const stored = db.prepare('SELECT body_html FROM posts ORDER BY id LIMIT 1').get();
  assert.ok(stored.body_html.includes('<script>'), 'XSS stays raw text in storage (inert by rendering model)');
  db.close();

  console.log('\n✅ All Forumly smoke tests passed (honeypot, min-time, rate limit, XSS-inert)');
}

async function cleanup(code) {
  if (serverProc && !serverProc.killed) serverProc.kill(); // ONLY the spawned child
  await sleep(300);
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* windows lock */ }
  }
  process.exit(code);
}

main()
  .then(() => cleanup(0))
  .catch(async (err) => {
    console.error('\n❌ Smoke test failed:', err.message);
    await cleanup(1);
  });
