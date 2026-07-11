import React, { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessagesSquare, Bell, Search, LogOut, Plus, Pin, Lock, Trash2, Pencil,
  ArrowLeft, Shield, User, Award, Ban, CornerDownRight, Check, X
} from 'lucide-react';
import { api, timeAgo } from './api.js';

// SECURITY: every piece of member-authored content (titles, bodies, bios,
// names) renders through React text nodes only — no raw-HTML injection APIs.

const input = 'w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500';
const btn = 'inline-flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium text-sm rounded-lg px-3.5 py-2 transition-colors disabled:opacity-50';
const btnGhost = 'inline-flex items-center gap-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm rounded-lg px-3 py-1.5 transition-colors';
const iconBtn = 'p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 transition-colors';
const EMOJIS = ['👍', '❤️', '😂', '🎉', '🤔', '🔥'];

function Avatar({ member, size = 8 }) {
  const px = size * 4;
  if (member?.avatar_path) {
    return <img src={member.avatar_path} alt="" style={{ width: px, height: px }} className="rounded-full object-cover shrink-0" />;
  }
  const initials = (member?.name || '?').slice(0, 2).toUpperCase();
  return (
    <span style={{ width: px, height: px, fontSize: px * 0.38 }}
      className="rounded-full bg-emerald-500/20 text-emerald-300 grid place-items-center font-semibold shrink-0">
      {initials}
    </span>
  );
}

// Composer wrapper: tracks mount time for the min-time-to-post check and
// carries the honeypot field (hidden from humans, tempting for bots).
function useSpamFields() {
  const mountedAt = useRef(Date.now());
  const [hp, setHp] = useState('');
  const fields = () => ({ hp, elapsed_ms: Date.now() - mountedAt.current });
  const honeypotInput = (
    <input type="text" value={hp} onChange={(e) => setHp(e.target.value)} name="website"
      autoComplete="off" tabIndex={-1} aria-hidden="true"
      style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
  );
  return { fields, honeypotInput };
}

function AuthModal({ onClose, onAuthed }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const { fields, honeypotInput } = useSpamFields();
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'register') await api.register({ ...form, ...fields() });
      else await api.login(form);
      onAuthed();
    } catch (err) { setError(err.message); }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.form initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} onSubmit={submit}
        className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-7 space-y-4">
        <h2 className="font-semibold text-center">{mode === 'register' ? 'Join the community' : 'Welcome back'}</h2>
        {honeypotInput}
        {mode === 'register' && (
          <input className={input} placeholder="Username (letters, numbers, . _ -)" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        )}
        <input className={input} type="email" placeholder="you@email.com" value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input className={input} type="password" placeholder="Password" value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })} />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className={`${btn} w-full justify-center`}>{mode === 'register' ? 'Sign up' : 'Sign in'}</button>
        <button type="button" className="w-full text-xs text-zinc-500 hover:text-zinc-300"
          onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>
          {mode === 'register' ? 'Have an account? Sign in' : 'New here? Create an account'}
        </button>
      </motion.form>
    </div>
  );
}

function ModLoginModal({ onClose, onAuthed }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="w-full max-w-xs bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-3"
        onSubmit={async (e) => { e.preventDefault(); try { await api.adminLogin(password); onAuthed(); } catch { setError('Wrong password'); } }}>
        <h2 className="font-semibold text-sm flex items-center gap-2"><Shield className="w-4 h-4 text-emerald-400" /> Moderator sign-in</h2>
        <input className={input} type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin password" />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className={`${btn} w-full justify-center`}>Sign in</button>
      </form>
    </div>
  );
}

function PostBody({ text }) {
  // plain text with preserved newlines; @mentions get a subtle highlight —
  // still text nodes, zero HTML interpretation
  const parts = String(text || '').split(/(@[A-Za-z0-9_.\-]{2,32})/g);
  return (
    <p className="text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
      {parts.map((p, i) => p.startsWith('@')
        ? <span key={i} className="text-emerald-400">{p}</span>
        : <React.Fragment key={i}>{p}</React.Fragment>)}
    </p>
  );
}

function Reactions({ post, me, onChanged }) {
  const [open, setOpen] = useState(false);
  const toggle = async (emoji) => {
    if (!me) return;
    const r = await api.react(post.id, emoji);
    onChanged(post.id, r.reactions);
    setOpen(false);
  };
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {(post.reactions || []).map((r) => (
        <button key={r.emoji} onClick={() => toggle(r.emoji)} disabled={!me}
          className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${r.mine ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-zinc-700 hover:border-zinc-500'}`}>
          {r.emoji} {r.count}
        </button>
      ))}
      {me && (
        <div className="relative">
          <button onClick={() => setOpen(!open)} className="text-xs px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-500 hover:border-zinc-500">+</button>
          {open && (
            <div className="absolute bottom-full mb-1 left-0 flex gap-1 bg-zinc-900 border border-zinc-700 rounded-xl px-2 py-1.5 z-10">
              {EMOJIS.map((e) => <button key={e} className="hover:scale-125 transition-transform" onClick={() => toggle(e)}>{e}</button>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Composer({ placeholder, onSubmit, busyLabel = 'Posting…', label = 'Post reply' }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { fields, honeypotInput } = useSpamFields();
  return (
    <form className="space-y-2 relative" onSubmit={async (e) => {
      e.preventDefault();
      if (!body.trim()) return;
      setBusy(true); setError('');
      try { await onSubmit(body.trim(), fields()); setBody(''); }
      catch (err) { setError(err.message); }
      finally { setBusy(false); }
    }}>
      {honeypotInput}
      <textarea className={`${input} min-h-24`} placeholder={placeholder} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex items-center gap-3">
        <button className={btn} disabled={busy || !body.trim()}>{busy ? busyLabel : label}</button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </form>
  );
}

// ── thread view ───────────────────────────────────────────────────────────────
function ThreadView({ threadId, me, moderator, onBack, onOpenProfile, requireAuth }) {
  const [data, setData] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editText, setEditText] = useState('');

  const load = useCallback(() => api.thread(threadId).then(setData).catch(() => {}), [threadId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return <p className="text-zinc-500 text-sm">Loading…</p>;
  const { thread, posts } = data;
  const tops = posts.filter((p) => !p.parent_post_id);
  const childrenOf = (id) => posts.filter((p) => p.parent_post_id === id);

  const setReactions = (postId, reactions) => {
    setData((d) => ({ ...d, posts: d.posts.map((p) => (p.id === postId ? { ...p, reactions } : p)) }));
  };

  const submitReply = async (body, spam) => {
    if (!me) { requireAuth(); throw new Error('Sign in to reply'); }
    await api.reply(threadId, { body, parent_post_id: replyTo, ...spam });
    setReplyTo(null);
    load();
  };

  const Post = ({ p, nested }) => (
    <div className={`${nested ? 'ml-10 mt-3' : ''}`}>
      <div className={`bg-zinc-900 border border-zinc-800 rounded-2xl p-4 ${p.deleted ? 'opacity-50' : ''}`}>
        <div className="flex items-center gap-2.5">
          <button onClick={() => onOpenProfile(p.author.id)}><Avatar member={p.author} size={7} /></button>
          <button onClick={() => onOpenProfile(p.author.id)} className="text-sm font-medium hover:text-emerald-400">{p.author.name}</button>
          {p.author.banned ? <span className="text-[10px] text-red-400 border border-red-500/40 rounded px-1">banned</span> : null}
          <span className="text-xs text-zinc-600">{timeAgo(p.created_at)}{p.edited_at ? ' · edited' : ''}</span>
          <div className="flex-1" />
          {(me?.id === p.author_id || moderator) && !p.deleted && (
            <>
              <button className={iconBtn} onClick={() => { setEditing(p.id); setEditText(p.body_html); }}><Pencil className="w-3.5 h-3.5" /></button>
              <button className={`${iconBtn} hover:text-red-400`} onClick={async () => { await api.deletePost(p.id); load(); }}><Trash2 className="w-3.5 h-3.5" /></button>
            </>
          )}
          {moderator && !p.author.banned && p.author.id !== me?.id && (
            <button className={`${iconBtn} hover:text-red-400`} title="Ban member" onClick={async () => { if (confirm(`Ban ${p.author.name}?`)) { await api.ban(p.author.id, true); load(); } }}>
              <Ban className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="mt-2.5">
          {p.deleted ? <p className="text-sm text-zinc-600 italic">[deleted]</p>
            : editing === p.id ? (
              <div className="space-y-2">
                <textarea className={`${input} min-h-20`} value={editText} onChange={(e) => setEditText(e.target.value)} />
                <div className="flex gap-2">
                  <button className={btn} onClick={async () => { await api.editPost(p.id, editText); setEditing(null); load(); }}><Check className="w-4 h-4" /> Save</button>
                  <button className={btnGhost} onClick={() => setEditing(null)}><X className="w-4 h-4" /> Cancel</button>
                </div>
              </div>
            ) : <PostBody text={p.body_html} />}
        </div>
        {!p.deleted && (
          <div className="mt-3 flex items-center gap-3">
            <Reactions post={p} me={me} onChanged={setReactions} />
            {!nested && !thread.locked && (
              <button className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
                onClick={() => (me ? setReplyTo(replyTo === p.id ? null : p.id) : requireAuth())}>
                <CornerDownRight className="w-3 h-3" /> reply
              </button>
            )}
          </div>
        )}
      </div>
      {childrenOf(p.id).map((c) => <Post key={c.id} p={c} nested />)}
      {replyTo === p.id && (
        <div className="ml-10 mt-3">
          <Composer placeholder={`Reply to ${p.author.name}…`} onSubmit={submitReply} />
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onBack} className={iconBtn}><ArrowLeft className="w-4 h-4" /></button>
        <h1 className="text-lg font-semibold flex-1 break-words">{thread.title}</h1>
        {!!thread.pinned && <span className="flex items-center gap-1 text-xs text-amber-400"><Pin className="w-3.5 h-3.5" /> pinned</span>}
        {!!thread.locked && <span className="flex items-center gap-1 text-xs text-zinc-500"><Lock className="w-3.5 h-3.5" /> locked</span>}
        {moderator && (
          <div className="flex gap-1.5">
            <button className={btnGhost} onClick={async () => { await api.pin(thread.id, !thread.pinned); load(); }}><Pin className="w-3.5 h-3.5" /> {thread.pinned ? 'Unpin' : 'Pin'}</button>
            <button className={btnGhost} onClick={async () => { await api.lock(thread.id, !thread.locked); load(); }}><Lock className="w-3.5 h-3.5" /> {thread.locked ? 'Unlock' : 'Lock'}</button>
            <button className={`${btnGhost} hover:border-red-500 hover:text-red-400`} onClick={async () => { if (confirm('Delete thread?')) { await api.deleteThread(thread.id); onBack(); } }}><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </div>
      <div className="space-y-3">
        {tops.map((p) => <Post key={p.id} p={p} />)}
      </div>
      {!thread.locked ? (
        me ? (
          replyTo === null && <Composer placeholder="Write a reply…" onSubmit={submitReply} />
        ) : (
          <button className={btnGhost} onClick={requireAuth}>Sign in to join the discussion</button>
        )
      ) : (
        <p className="text-sm text-zinc-600 flex items-center gap-1.5"><Lock className="w-4 h-4" /> This thread is locked.</p>
      )}
    </div>
  );
}

// ── profile view ──────────────────────────────────────────────────────────────
function ProfileView({ memberId, me, moderator, onBack, onOpenThread }) {
  const [data, setData] = useState(null);
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => api.profile(memberId).then((d) => { setData(d); setBio(d.member.bio); setAvatar(d.member.avatar_path); }).catch(() => {}), [memberId]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <p className="text-zinc-500 text-sm">Loading…</p>;
  const m = data.member;
  return (
    <div className="space-y-6 max-w-2xl">
      <button onClick={onBack} className={iconBtn}><ArrowLeft className="w-4 h-4" /></button>
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 flex items-start gap-4">
        <Avatar member={m} size={14} />
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-semibold">{m.name}</h1>
            {!!m.banned && <span className="text-xs text-red-400 border border-red-500/40 rounded px-1.5">banned</span>}
            {data.badges.map((b) => (
              <span key={b.id} title={b.label} className="text-xs bg-zinc-800 border border-zinc-700 rounded-full px-2 py-0.5">{b.icon} {b.label}</span>
            ))}
          </div>
          <p className="text-xs text-zinc-500 mt-1">Joined {new Date(m.joined_at).toLocaleDateString()} · {data.post_count} posts</p>
          {editing ? (
            <div className="mt-3 space-y-2">
              <textarea className={`${input} min-h-16`} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Your bio…" />
              <input className={input} value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="Avatar URL (https://…)" />
              <div className="flex gap-2">
                <button className={btn} onClick={async () => { await api.saveProfile({ bio, avatar_path: avatar }); setEditing(false); load(); }}><Check className="w-4 h-4" /> Save</button>
                <button className={btnGhost} onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            m.bio ? <p className="text-sm text-zinc-300 mt-3 whitespace-pre-wrap">{m.bio}</p> : <p className="text-sm text-zinc-600 mt-3 italic">No bio yet.</p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          {me?.id === m.id && !editing && <button className={btnGhost} onClick={() => setEditing(true)}><Pencil className="w-3.5 h-3.5" /> Edit</button>}
          {moderator && (
            <>
              <button className={btnGhost} onClick={async () => {
                const label = prompt('Badge label (e.g. "Founding member")');
                if (label) { await api.awardBadge(m.id, { label, icon: prompt('Icon emoji', '🏅') || '🏅' }); load(); }
              }}><Award className="w-3.5 h-3.5" /> Badge</button>
              <button className={`${btnGhost} hover:border-red-500 hover:text-red-400`} onClick={async () => { await api.ban(m.id, !m.banned); load(); }}>
                <Ban className="w-3.5 h-3.5" /> {m.banned ? 'Unban' : 'Ban'}
              </button>
            </>
          )}
        </div>
      </div>
      <div>
        <h2 className="text-sm font-medium text-zinc-400 mb-2">Recent posts</h2>
        <div className="space-y-2">
          {data.recent_posts.map((p) => (
            <button key={p.id} onClick={() => onOpenThread(p.thread_id)}
              className="w-full text-left bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-xl p-3 transition-colors">
              <p className="text-xs text-zinc-500">{p.thread_title} · {timeAgo(p.created_at)}</p>
              <p className="text-sm text-zinc-300 line-clamp-2 mt-0.5">{p.body_html}</p>
            </button>
          ))}
          {data.recent_posts.length === 0 && <p className="text-sm text-zinc-600">Nothing yet.</p>}
        </div>
      </div>
    </div>
  );
}

// ── main app ──────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null); // {member, moderator, unread}
  const [view, setView] = useState({ name: 'home' });
  const [cats, setCats] = useState([]);
  const [catData, setCatData] = useState(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showModLogin, setShowModLogin] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState([]);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [composing, setComposing] = useState(false);

  const refreshMe = useCallback(() => api.me().then(setSession).catch(() => setSession({ member: null, moderator: false, unread: 0 })), []);
  const loadCats = useCallback(() => api.categories().then(setCats).catch(() => {}), []);
  useEffect(() => { refreshMe(); }, [refreshMe]);
  useEffect(() => { if (view.name === 'home') loadCats(); }, [view, loadCats]);
  useEffect(() => {
    if (view.name === 'category') api.threads(view.id).then(setCatData).catch(() => {});
  }, [view]);

  const me = session?.member || null;
  const moderator = !!session?.moderator;

  const openNotifs = async () => {
    setNotifOpen(!notifOpen);
    if (!notifOpen) {
      const rows = await api.notifications();
      setNotifs(rows);
      await api.markRead();
      refreshMe();
    }
  };

  const doSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    const r = await api.search(query.trim());
    setSearchResults(r);
    setView({ name: 'search' });
  };

  if (!session) return <div className="min-h-screen grid place-items-center text-zinc-600">Loading…</div>;

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-5 h-14 flex items-center gap-3">
          <button onClick={() => { setView({ name: 'home' }); setSearchResults(null); }} className="flex items-center gap-2 font-semibold">
            <MessagesSquare className="w-5 h-5 text-emerald-400" /> Forumly
          </button>
          <form onSubmit={doSearch} className="flex-1 max-w-xs ml-2 relative hidden sm:block">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
            <input className={`${input} pl-8 py-1.5`} placeholder="Search threads…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </form>
          <div className="flex-1" />
          {moderator && <span className="flex items-center gap-1 text-xs text-emerald-400"><Shield className="w-3.5 h-3.5" /> mod</span>}
          {me ? (
            <>
              <div className="relative">
                <button className={iconBtn} onClick={openNotifs}>
                  <Bell className="w-4 h-4" />
                  {session.unread > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 bg-emerald-500 text-zinc-950 text-[10px] font-bold rounded-full min-w-4 h-4 grid place-items-center px-0.5">
                      {session.unread}
                    </span>
                  )}
                </button>
                <AnimatePresence>
                  {notifOpen && (
                    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                      className="absolute right-0 mt-2 w-80 bg-zinc-900 border border-zinc-700 rounded-2xl p-2 shadow-2xl max-h-96 overflow-y-auto">
                      {notifs.map((n) => (
                        <button key={n.id} onClick={() => { setNotifOpen(false); if (n.thread_id) setView({ name: 'thread', id: n.thread_id }); }}
                          className={`w-full text-left px-3 py-2 rounded-xl hover:bg-zinc-800 text-sm ${n.read ? 'text-zinc-500' : 'text-zinc-200'}`}>
                          <span className="font-medium">{n.actor?.name || 'Someone'}</span>
                          {n.type === 'mention' ? ' mentioned you in ' : ' replied in '}
                          <span className="text-emerald-400">{n.thread_title || 'a thread'}</span>
                          <span className="block text-xs text-zinc-600">{timeAgo(n.at)}</span>
                        </button>
                      ))}
                      {notifs.length === 0 && <p className="text-sm text-zinc-600 p-3">No notifications yet.</p>}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <button onClick={() => setView({ name: 'profile', id: me.id })} className="flex items-center gap-2">
                <Avatar member={me} size={7} />
              </button>
              <button className={iconBtn} title="Sign out" onClick={async () => { await api.logout(); refreshMe(); }}><LogOut className="w-4 h-4" /></button>
            </>
          ) : (
            <>
              <button className={btnGhost} onClick={() => setShowAuth(true)}><User className="w-3.5 h-3.5" /> Sign in</button>
              <button className={iconBtn} title="Moderator" onClick={() => setShowModLogin(true)}><Shield className="w-4 h-4" /></button>
            </>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 py-8">
        {view.name === 'home' && (
          <div className="space-y-3">
            {moderator && (
              <button className={btnGhost} onClick={async () => {
                const name = prompt('Category name');
                if (name) { await api.createCategory({ name, description: prompt('Description') || '' }); loadCats(); }
              }}><Plus className="w-3.5 h-3.5" /> New category</button>
            )}
            {cats.map((c) => (
              <button key={c.id} onClick={() => setView({ name: 'category', id: c.id })}
                className="w-full text-left bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-2xl p-5 transition-colors">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  {c.has_new && <span className="w-2 h-2 rounded-full bg-emerald-400" title="New since your last visit" />}
                  <div className="flex-1" />
                  <span className="text-xs text-zinc-500">{c.thread_count} threads · {c.post_count} posts</span>
                </div>
                {c.description && <p className="text-sm text-zinc-500 mt-1">{c.description}</p>}
                {c.latest_thread && (
                  <p className="text-xs text-zinc-600 mt-2">
                    Latest: <span className="text-zinc-400">{c.latest_thread.title}</span> by {c.latest_thread.author.name} · {timeAgo(c.latest_thread.last_post_at)}
                  </p>
                )}
              </button>
            ))}
          </div>
        )}

        {view.name === 'category' && catData && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <button onClick={() => setView({ name: 'home' })} className={iconBtn}><ArrowLeft className="w-4 h-4" /></button>
              <div className="flex-1">
                <h1 className="text-lg font-semibold">{catData.category.name}</h1>
                <p className="text-sm text-zinc-500">{catData.category.description}</p>
              </div>
              {me && <button className={btn} onClick={() => setComposing(!composing)}><Plus className="w-4 h-4" /> New thread</button>}
              {!me && <button className={btnGhost} onClick={() => setShowAuth(true)}>Sign in to post</button>}
              {moderator && (
                <button className={`${iconBtn} hover:text-red-400`} title="Delete category"
                  onClick={async () => { if (confirm('Delete category and all threads?')) { await api.deleteCategory(catData.category.id); setView({ name: 'home' }); } }}>
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
            {composing && me && (
              <NewThread categoryId={catData.category.id} onDone={(threadId) => { setComposing(false); setView({ name: 'thread', id: threadId }); }} />
            )}
            <div className="space-y-2">
              {catData.threads.map((t) => (
                <button key={t.id} onClick={() => setView({ name: 'thread', id: t.id })}
                  className="w-full text-left bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-xl px-4 py-3 transition-colors">
                  <div className="flex items-center gap-2">
                    {!!t.pinned && <Pin className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                    {!!t.locked && <Lock className="w-3.5 h-3.5 text-zinc-600 shrink-0" />}
                    <span className="font-medium text-sm truncate">{t.title}</span>
                    {t.is_new && <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" title="New since your last visit" />}
                    <div className="flex-1" />
                    <span className="text-xs text-zinc-500 shrink-0">{t.reply_count} replies · {timeAgo(t.last_post_at)}</span>
                  </div>
                  <p className="text-xs text-zinc-600 mt-1">by {t.author.name}</p>
                </button>
              ))}
              {catData.threads.length === 0 && <p className="text-sm text-zinc-600 py-8 text-center">No threads yet — start the first one.</p>}
            </div>
          </div>
        )}

        {view.name === 'thread' && (
          <ThreadView threadId={view.id} me={me} moderator={moderator}
            onBack={() => setView(catData ? { name: 'category', id: catData.category.id } : { name: 'home' })}
            onOpenProfile={(id) => setView({ name: 'profile', id })}
            requireAuth={() => setShowAuth(true)} />
        )}

        {view.name === 'profile' && (
          <ProfileView memberId={view.id} me={me} moderator={moderator}
            onBack={() => setView({ name: 'home' })}
            onOpenThread={(id) => setView({ name: 'thread', id })} />
        )}

        {view.name === 'search' && searchResults && (
          <div className="space-y-3">
            <h1 className="text-lg font-semibold">Search: “{searchResults.q}”</h1>
            {searchResults.results.map((t) => (
              <button key={t.id} onClick={() => setView({ name: 'thread', id: t.id })}
                className="w-full text-left bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-xl px-4 py-3 transition-colors">
                <p className="font-medium text-sm">{t.title}</p>
                {t.snippet && <p className="text-xs text-zinc-500 mt-1 line-clamp-2">…{t.snippet}…</p>}
                <p className="text-xs text-zinc-600 mt-1">by {t.author.name} · {t.reply_count} replies</p>
              </button>
            ))}
            {searchResults.results.length === 0 && <p className="text-sm text-zinc-600">No matches.</p>}
          </div>
        )}
      </main>

      <AnimatePresence>
        {showAuth && <AuthModal onClose={() => setShowAuth(false)} onAuthed={() => { setShowAuth(false); refreshMe(); }} />}
        {showModLogin && <ModLoginModal onClose={() => setShowModLogin(false)} onAuthed={() => { setShowModLogin(false); refreshMe(); }} />}
      </AnimatePresence>
    </div>
  );
}

function NewThread({ categoryId, onDone }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const { fields, honeypotInput } = useSpamFields();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3 relative"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError('');
        try {
          const r = await api.createThread({ category_id: categoryId, title, body, ...fields() });
          onDone(r.id);
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
      }}>
      {honeypotInput}
      <input className={input} placeholder="Thread title…" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className={`${input} min-h-28`} placeholder="What's on your mind? Use @name to mention someone." value={body} onChange={(e) => setBody(e.target.value)} />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button className={btn} disabled={busy || !title.trim() || !body.trim()}>{busy ? 'Creating…' : 'Create thread'}</button>
    </form>
  );
}
