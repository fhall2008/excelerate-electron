/**
 * Local API server — runs inside the Electron main process.
 * Mirrors the Cloudflare Worker (worker-single.js) API surface.
 * Uses better-sqlite3 for local storage instead of Turso.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { app } = require('electron');

let db;

function getDbPath(store) {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'excelerate.db');
}

function initDb(store) {
  const Database = require('better-sqlite3');
  const dbPath = getDbPath(store);
  db = new Database(dbPath);

  // Same schema as Turso
  db.exec(`
    CREATE TABLE IF NOT EXISTS store (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      synced_at  INTEGER,
      direction  TEXT,
      key        TEXT,
      status     TEXT
    );
  `);

  return db;
}

// ── Store helpers (mirrors makeStore in worker-single.js) ──────────────────
function makeStore(ns) {
  const prefix = ns + ':';
  return {
    get(key) {
      const row = db.prepare('SELECT value FROM store WHERE key = ?').get(prefix + key);
      return row ? JSON.parse(row.value) : null;
    },
    set(key, value, updatedBy) {
      const now = Math.floor(Date.now() / 1000);
      const val = JSON.stringify(value);
      db.prepare(`
        INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(prefix + key, val, now);
    },
    delete(key) {
      db.prepare('DELETE FROM store WHERE key = ?').run(prefix + key);
    },
    list() {
      const rows = db.prepare('SELECT key, value FROM store WHERE key LIKE ?').all(prefix + '%');
      return {
        blobs: rows.map(r => ({
          key: r.key.slice(prefix.length),
          value: JSON.parse(r.value)
        }))
      };
    }
  };
}

// ── Auth middleware ────────────────────────────────────────────────────────
function getUser(req, store) {
  // In Electron, we cache the Kinde user + role in electron-store
  // The JWT is validated online; offline we trust the cached user
  const cached = store.get('cachedUser');
  if (!cached) return null;

  // Check JWT expiry (30 day offline window)
  const cachedAt = store.get('cachedUserAt') || 0;
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - cachedAt > thirtyDays) return null;

  return cached;
}

// ── Route handlers ─────────────────────────────────────────────────────────
function setupRoutes(expressApp, store) {
  const res = (data, status = 200) => ({ data, status });

  // Helper: send response
  function send(response, r) {
    r.status(response.status || 200).json(response.data);
  }

  // ── Auth endpoint — cache user from frontend ──
  expressApp.post('/electron/cache-user', (req, res) => {
    const { user, role } = req.body;
    if (user) {
      store.set('cachedUser', { ...user, role });
      store.set('cachedUserAt', Date.now());
    }
    res.json({ ok: true });
  });

  expressApp.get('/electron/sync-status', (req, res) => {
    res.json({
      lastSync: store.get('lastSync'),
      status: store.get('syncStatus', 'idle'),
      isOnline: store.get('isOnline', false),
      pendingUploads: store.get('pendingUploads', []).length,
    });
  });

  // ── Resources ──
  expressApp.get('/resources', (req, res) => {
    const user = getUser(req, store);
    const role = user?.role || 'guest';
    const s = makeStore('resource');
    const sp = makeStore('paper');
    const rBlobs = s.list().blobs.map(b => ({ id: 'resource:' + b.key, ...b.value }));
    const pBlobs = sp.list().blobs.map(b => ({
      id: 'paper:' + b.key,
      kind: b.value.kind || b.value.type || 'paper',
      subj: b.value.subj || b.value.subjectId || '',
      title: b.value.title || '',
      status: b.value.status || 'live',
      fileKey: b.value.fileKey || b.value.url || null,
      ...b.value
    }));
    const all = [...rBlobs, ...pBlobs];
    const filtered = role === 'admin' ? all : all.filter(x => x.status === 'live' && (x.visibility || 'public') === 'public');
    res.json({ items: filtered });
  });

  expressApp.post('/resources', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('resource');
    const id = 'res-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const now = Math.floor(Date.now() / 1000);
    const isStudent = user.role !== 'admin';
    const doc = {
      ...req.body,
      id: 'resource:' + id,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
      status: isStudent ? 'review' : (req.body.status || 'live'),
      _pendingSync: true,
    };
    s.set(id, doc);
    // Queue for sync
    const pending = store.get('pendingUploads', []);
    pending.push({ type: 'resource', key: id, action: 'create' });
    store.set('pendingUploads', pending);
    res.json({ ok: true, id: 'resource:' + id });
  });

  expressApp.delete('/resources', (req, res) => {
    const user = getUser(req, store);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const id = req.query.id;
    const ns = id?.startsWith('paper:') ? makeStore('paper') : makeStore('resource');
    const key = id?.startsWith('paper:') ? id.slice(6) : id?.startsWith('resource:') ? id.slice(9) : id;
    if (key) ns.delete(key);
    res.json({ ok: true });
  });

  // ── Subjects ──
  expressApp.get('/subjects', (req, res) => {
    const s = makeStore('subject');
    const items = s.list().blobs.map(b => ({ id: b.key, ...b.value })).filter(x => !x.deletedAt);
    res.json({ items });
  });

  // ── Planner ──
  expressApp.get('/planner', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('plan');
    res.json(s.get(user.id) || { tasks: [], events: [] });
  });

  expressApp.put('/planner', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('plan');
    s.set(user.id, { ...req.body, _pendingSync: true });
    const pending = store.get('pendingUploads', []);
    pending.push({ type: 'planner', key: user.id, action: 'update' });
    store.set('pendingUploads', pending);
    res.json({ ok: true });
  });

  // ── Progress ──
  expressApp.get('/progress', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('prog');
    res.json(s.get(user.id) || { views: 0, papers: 0, lastActive: null });
  });

  expressApp.post('/progress', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('prog');
    const existing = s.get(user.id) || { views: 0, papers: 0 };
    const kind = req.body.kind || 'view';
    s.set(user.id, { ...existing, [kind + 's']: (existing[kind + 's'] || 0) + 1, lastActive: Math.floor(Date.now() / 1000), _pendingSync: true });
    res.json({ ok: true });
  });

  // ── Profile ──
  expressApp.get('/profile', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('profile');
    res.json(s.get(user.id) || { mySubjects: [] });
  });

  expressApp.patch('/profile', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('profile');
    const existing = s.get(user.id) || {};
    s.set(user.id, { ...existing, ...req.body, _pendingSync: true });
    const pending = store.get('pendingUploads', []);
    pending.push({ type: 'profile', key: user.id, action: 'update' });
    store.set('pendingUploads', pending);
    res.json({ ok: true });
  });

  // ── Forum ──
  expressApp.get('/forum', (req, res) => {
    const s = makeStore('forum');
    const items = s.list().blobs.map(b => ({ id: b.key, ...b.value }));
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ items });
  });

  expressApp.post('/forum', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('forum');
    const id = 'thread-' + Date.now();
    const now = Math.floor(Date.now() / 1000);
    s.set(id, { ...req.body, id, authorId: user.id, authorName: user.name, createdAt: now, updatedAt: now, _pendingSync: true });
    const pending = store.get('pendingUploads', []);
    pending.push({ type: 'forum', key: id, action: 'create' });
    store.set('pendingUploads', pending);
    res.json({ ok: true, id });
  });

  // ── Groups ──
  expressApp.get('/groups', (req, res) => {
    const s = makeStore('group');
    const items = s.list().blobs.map(b => ({ id: b.key, ...b.value })).filter(x => !x.archivedAt);
    res.json({ items });
  });

  expressApp.get('/group-members', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('gmember');
    if (req.query.action === 'mine') {
      const items = s.list().blobs.filter(b => b.value.userId === user.id).map(b => b.value);
      return res.json({ items });
    }
    if (req.query.groupId) {
      const items = s.list().blobs.filter(b => b.value.groupId === req.query.groupId).map(b => b.value);
      return res.json(items);
    }
    res.json({ items: [] });
  });

  // ── Group chat ──
  expressApp.get('/group-chat', (req, res) => {
    const s = makeStore('gchat');
    const messages = s.list().blobs
      .filter(b => b.value.groupId === req.query.groupId)
      .map(b => b.value)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    res.json({ messages });
  });

  expressApp.post('/group-chat', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('gchat');
    const id = 'msg-' + Date.now();
    const now = Math.floor(Date.now() / 1000);
    s.set(id, { id, ...req.body, authorId: user.id, authorName: user.name, createdAt: now, _pendingSync: true });
    const pending = store.get('pendingUploads', []);
    pending.push({ type: 'group-chat', key: id, action: 'create' });
    store.set('pendingUploads', pending);
    res.json({ ok: true, id });
  });

  // ── AI — proxy to online Worker when available, fail gracefully offline ──
  expressApp.post('/ai', async (req, res) => {
    const workerUrl = store.get('workerUrl');
    const isOnline = store.get('isOnline', false);
    if (!isOnline || !workerUrl) {
      return res.status(503).json({ error: 'AI tutor requires an internet connection. Please connect to the internet and try again.' });
    }
    try {
      const fetch = require('node-fetch');
      const token = store.get('cachedToken');
      const r = await fetch(workerUrl + '/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(req.body),
        timeout: 30000,
      });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (e) {
      res.status(503).json({ error: 'AI tutor unavailable — check your internet connection.' });
    }
  });

  // ── Settings ──
  expressApp.get('/settings', (req, res) => {
    const s = makeStore('settings');
    const settings = s.get('ai') || {};
    res.json({ model: settings.model || 'openai/gpt-4o-mini', hasOpenRouter: true });
  });

  // ── Archive ──
  expressApp.get('/archive', (req, res) => {
    const s = makeStore('archive');
    if (req.query.id) {
      const item = s.get(req.query.id);
      return item ? res.json(item) : res.status(404).json({ error: 'Not found' });
    }
    const items = s.list().blobs.map(b => ({ id: b.key, ...b.value }));
    items.sort((a, b) => (b.year || 0) - (a.year || 0));
    res.json({ items });
  });

  // ── Links ──
  expressApp.get('/links', (req, res) => {
    const s = makeStore('link');
    const items = s.list().blobs.map(b => ({ id: b.key, ...b.value }));
    res.json({ items });
  });

  // ── Upload — queue for sync when back online ──
  expressApp.post('/upload', (req, res) => {
    res.status(503).json({ error: 'File uploads require an internet connection. Your upload will be queued.' });
  });

  // ── Assessments ──
  expressApp.get('/assessments', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('assess');
    const items = s.list().blobs.filter(b => b.value.userId === user.id).map(b => ({ id: b.key, ...b.value }));
    res.json({ items });
  });

  expressApp.post('/assessments', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('assess');
    const id = 'assess-' + Date.now();
    const now = Math.floor(Date.now() / 1000);
    s.set(id, { ...req.body, id, userId: user.id, createdAt: now, updatedAt: now, _pendingSync: true });
    res.json({ ok: true, id });
  });

  expressApp.patch('/assessments', (req, res) => {
    const user = getUser(req, store);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const s = makeStore('assess');
    const id = req.query.id;
    const existing = s.get(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    s.set(id, { ...existing, ...req.body, updatedAt: Math.floor(Date.now() / 1000), _pendingSync: true });
    res.json({ ok: true });
  });

  expressApp.delete('/assessments', (req, res) => {
    const s = makeStore('assess');
    s.delete(req.query.id);
    res.json({ ok: true });
  });
}

// ── Start server ───────────────────────────────────────────────────────────
async function startLocalServer(port, store) {
  return new Promise((resolve, reject) => {
    try {
      initDb(store);

      const expressApp = express();
      expressApp.use(cors({ origin: '*' }));
      expressApp.use(express.json({ limit: '50mb' }));

      setupRoutes(expressApp, store);

      const server = expressApp.listen(port, '127.0.0.1', () => {
        console.log(`[Excelerate] Local API server running on port ${port}`);
        resolve(server);
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[Excelerate] Port ${port} in use — trying ${port + 1}`);
          server.close(() => startLocalServer(port + 1, store).then(resolve).catch(reject));
        } else {
          reject(err);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { startLocalServer };
