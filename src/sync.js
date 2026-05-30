/**
 * Sync engine — runs in the Electron main process.
 * Pulls content from the school's Cloudflare Worker and pushes local changes.
 *
 * Sync strategy:
 *   DOWN: subjects, resources, papers, forum threads, archive, links, group info
 *   UP:   planner, progress, profile, forum replies, chat messages, assessments
 *   CONFLICT: server wins for shared content; local wins for user-owned data
 */

const fetch = require('node-fetch');

const SYNC_INTERVAL_MS = 60 * 1000; // 60 seconds
const SYNC_TIMEOUT_MS = 15 * 1000;  // 15 second request timeout
const ONLINE_CHECK_URL = 'https://1.1.1.1'; // Cloudflare DNS — fast, reliable

let syncTimer = null;
let isSyncing = false;

// ── Online check ───────────────────────────────────────────────────────────
async function checkOnline() {
  try {
    const res = await fetch(ONLINE_CHECK_URL, { method: 'HEAD', timeout: 3000 });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

// ── Pull from server ───────────────────────────────────────────────────────
async function pullFromServer(workerUrl, token, db) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  const pulled = { success: 0, failed: 0 };

  const endpoints = [
    { path: '/subjects', prefix: 'subject' },
    { path: '/resources', prefix: '_resources' }, // handled specially below
    { path: '/archive', prefix: 'archive' },
    { path: '/links', prefix: 'link' },
    { path: '/groups', prefix: 'group' },
  ];

  for (const { path, prefix } of endpoints) {
    try {
      const res = await fetch(workerUrl + path, { headers, timeout: SYNC_TIMEOUT_MS });
      if (!res.ok) { pulled.failed++; continue; }
      const data = await res.json();
      const items = data.items || (Array.isArray(data) ? data : []);

      if (prefix === '_resources') {
        // Resources split across resource: and paper: prefixes
        for (const item of items) {
          const key = item.id || ('res-' + Date.now());
          const val = JSON.stringify(item);
          const now = Math.floor(Date.now() / 1000);
          db.prepare(`
            INSERT INTO store (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            WHERE json_extract(excluded.value, '$._pendingSync') IS NULL
          `).run(key, val, now, now);
        }
      } else {
        for (const item of items) {
          const key = prefix + ':' + (item.id || item.key);
          const val = JSON.stringify(item);
          const now = Math.floor(Date.now() / 1000);
          db.prepare(`
            INSERT INTO store (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            WHERE json_extract(excluded.value, '$._pendingSync') IS NULL
          `).run(key, val, now, now);
        }
      }
      pulled.success++;
    } catch (e) {
      console.error(`[Sync] Pull failed for ${path}:`, e.message);
      pulled.failed++;
    }
  }

  return pulled;
}

// ── Push to server ─────────────────────────────────────────────────────────
async function pushToServer(workerUrl, token, store, db) {
  const pending = store.get('pendingUploads', []);
  if (pending.length === 0) return { pushed: 0, failed: 0 };

  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  const remaining = [];
  let pushed = 0;
  let failed = 0;

  for (const item of pending) {
    try {
      const row = db.prepare('SELECT value FROM store WHERE key = ?').get(item.prefix + ':' + item.key);
      if (!row) continue; // item deleted locally, skip

      const body = JSON.parse(row.value);
      delete body._pendingSync;

      let url = workerUrl;
      let method = 'POST';

      switch (item.type) {
        case 'planner':    url += '/planner';    method = 'PUT';   break;
        case 'profile':    url += '/profile';    method = 'PATCH'; break;
        case 'progress':   url += '/progress';   method = 'POST';  break;
        case 'resource':   url += '/resources';  method = 'POST';  break;
        case 'forum':      url += '/forum';      method = 'POST';  break;
        case 'group-chat': url += '/group-chat'; method = 'POST';  break;
        default: continue;
      }

      const res = await fetch(url, { method, headers, body: JSON.stringify(body), timeout: SYNC_TIMEOUT_MS });
      if (res.ok) {
        // Mark as synced
        const updated = { ...body, _pendingSync: false };
        db.prepare('UPDATE store SET value = ? WHERE key = ?').run(JSON.stringify(updated), item.prefix + ':' + item.key);
        pushed++;
      } else {
        remaining.push(item);
        failed++;
      }
    } catch (e) {
      console.error(`[Sync] Push failed for ${item.type}/${item.key}:`, e.message);
      remaining.push(item);
      failed++;
    }
  }

  store.set('pendingUploads', remaining);
  return { pushed, failed };
}

// ── Main sync function ─────────────────────────────────────────────────────
async function runSync(store, localPort) {
  if (isSyncing) return { skipped: true };
  isSyncing = true;

  try {
    const online = await checkOnline();
    store.set('isOnline', online);

    if (!online) {
      store.set('syncStatus', 'offline');
      return { status: 'offline' };
    }

    const workerUrl = store.get('workerUrl');
    const token = store.get('cachedToken');

    if (!workerUrl) {
      store.set('syncStatus', 'not-configured');
      return { status: 'not-configured' };
    }

    store.set('syncStatus', 'syncing');

    // Get the local DB instance
    const Database = require('better-sqlite3');
    const { app } = require('electron');
    const path = require('path');
    const dbPath = path.join(app.getPath('userData'), 'excelerate.db');
    const db = new Database(dbPath);

    // Pull from server first
    const pulled = await pullFromServer(workerUrl, token, db);

    // Push local changes
    const pushed = await pushToServer(workerUrl, token, store, db);

    store.set('lastSync', Date.now());
    store.set('syncStatus', 'synced');

    console.log(`[Sync] Complete — pulled: ${pulled.success}, pushed: ${pushed.pushed}`);
    return { status: 'synced', pulled, pushed };

  } catch (e) {
    console.error('[Sync] Error:', e);
    store.set('syncStatus', 'error');
    return { status: 'error', message: e.message };
  } finally {
    isSyncing = false;
  }
}

// ── Start background sync ──────────────────────────────────────────────────
function startSyncEngine(store, localPort) {
  // Read worker URL from the WebFiles config if not already set
  if (!store.get('workerUrl')) {
    // Try to read from bundled config.js
    try {
      const { app } = require('electron');
      const path = require('path');
      const fs = require('fs');
      const configPath = app.isPackaged
        ? path.join(process.resourcesPath, 'WebFiles', 'config.js')
        : path.join(__dirname, '..', 'webfiles', 'project', 'WebFiles', 'config.js');

      if (fs.existsSync(configPath)) {
        const configText = fs.readFileSync(configPath, 'utf-8');
        const match = configText.match(/apiUrl:\s*['"]([^'"]+)['"]/);
        if (match) {
          store.set('workerUrl', match[1]);
          console.log('[Sync] Worker URL loaded from config:', match[1]);
        }
      }
    } catch (e) {
      console.error('[Sync] Could not read config.js:', e.message);
    }
  }

  // Initial sync after 3 second delay (let app load first)
  setTimeout(() => runSync(store, localPort), 3000);

  // Then sync every 60 seconds
  syncTimer = setInterval(() => runSync(store, localPort), SYNC_INTERVAL_MS);

  console.log('[Sync] Engine started — syncing every 60 seconds');
}

module.exports = { startSyncEngine, runSync };
