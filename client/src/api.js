async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  me: () => req('/api/me'),
  register: (body) => req('/api/register', { method: 'POST', body }),
  login: (body) => req('/api/login', { method: 'POST', body }),
  logout: () => req('/api/logout', { method: 'POST' }),
  adminLogin: (password) => req('/api/admin/login', { method: 'POST', body: { password } }),
  categories: () => req('/api/categories'),
  createCategory: (body) => req('/api/categories', { method: 'POST', body }),
  deleteCategory: (id) => req(`/api/categories/${id}`, { method: 'DELETE' }),
  threads: (categoryId) => req(`/api/categories/${categoryId}/threads`),
  thread: (id) => req(`/api/threads/${id}`),
  createThread: (body) => req('/api/threads', { method: 'POST', body }),
  reply: (threadId, body) => req(`/api/threads/${threadId}/posts`, { method: 'POST', body }),
  editPost: (id, body) => req(`/api/posts/${id}`, { method: 'PUT', body: { body } }),
  deletePost: (id) => req(`/api/posts/${id}`, { method: 'DELETE' }),
  react: (postId, emoji) => req(`/api/posts/${postId}/react`, { method: 'POST', body: { emoji } }),
  pin: (id, pinned) => req(`/api/threads/${id}/pin`, { method: 'POST', body: { pinned } }),
  lock: (id, locked) => req(`/api/threads/${id}/lock`, { method: 'POST', body: { locked } }),
  deleteThread: (id) => req(`/api/threads/${id}`, { method: 'DELETE' }),
  ban: (memberId, banned) => req(`/api/members/${memberId}/ban`, { method: 'POST', body: { banned } }),
  awardBadge: (memberId, body) => req(`/api/members/${memberId}/badges`, { method: 'POST', body }),
  profile: (id) => req(`/api/members/${id}`),
  saveProfile: (body) => req('/api/profile', { method: 'PUT', body }),
  notifications: () => req('/api/notifications'),
  markRead: (ids) => req('/api/notifications/read', { method: 'POST', body: { ids } }),
  search: (q) => req(`/api/search?q=${encodeURIComponent(q)}`)
};

export function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
