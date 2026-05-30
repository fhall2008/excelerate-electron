/**
 * electron-bridge.js
 * 
 * Drop this file into project/WebFiles/ and add a script tag in index.html:
 *   <script src="electron-bridge.js"></script>
 *
 * This file:
 * 1. Detects if running in Electron
 * 2. When Kinde auth fires, caches the user + JWT to the local Express server
 * 3. Shows an online/offline indicator in the corner
 * 4. Overrides file upload to show "requires internet" message offline
 */

(function () {
  if (!window.__ELECTRON__) return; // Only runs inside the Electron app

  const LOCAL_API = window.EXCELERATE_CONFIG?.apiUrl || 'http://localhost:3741';

  // ── Cache user to local server when auth fires ──────────────────────────
  function cacheUserLocally(user, role, token) {
    if (!user) return;
    fetch(LOCAL_API + '/electron/cache-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { ...user, role }, role, token }),
    }).catch(() => {});

    // Also cache token for AI proxy
    if (token) {
      localStorage.setItem('__electron_token', token);
    }
  }

  // Hook into VelocityAuth subscribe
  function hookAuth() {
    if (!window.VelocityAuth) {
      setTimeout(hookAuth, 200);
      return;
    }

    window.VelocityAuth.subscribe(async (user, role) => {
      if (user) {
        try {
          const token = await user.jwt?.();
          cacheUserLocally(user, role, token);
        } catch (e) {}
      }
    });
  }

  // ── Online/offline indicator ────────────────────────────────────────────
  function createSyncIndicator() {
    const el = document.createElement('div');
    el.id = 'electron-sync-indicator';
    el.style.cssText = `
      position: fixed;
      bottom: 12px;
      right: 12px;
      z-index: 9999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 20px;
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      transition: opacity 0.3s;
      opacity: 0.7;
    `;

    function updateIndicator(status, isOnline) {
      const colors = {
        synced:   { bg: '#dcfce7', color: '#166534', dot: '#16a34a' },
        syncing:  { bg: '#dbeafe', color: '#1e40af', dot: '#2563eb' },
        offline:  { bg: '#fee2e2', color: '#991b1b', dot: '#ef4444' },
        error:    { bg: '#fef3c7', color: '#92400e', dot: '#d97706' },
        idle:     { bg: '#f1f5f9', color: '#475569', dot: '#94a3b8' },
      };
      const c = colors[status] || colors.idle;
      el.style.background = c.bg;
      el.style.color = c.color;
      el.innerHTML = `
        <span style="width:7px;height:7px;border-radius:50%;background:${c.dot};display:inline-block"></span>
        ${isOnline ? (status === 'synced' ? 'Synced' : status === 'syncing' ? 'Syncing…' : 'Online') : 'Offline'}
      `;
    }

    el.addEventListener('click', async () => {
      const status = await fetch(LOCAL_API + '/electron/sync-status').then(r => r.json()).catch(() => null);
      if (!status) return;
      const lastSync = status.lastSync ? new Date(status.lastSync).toLocaleTimeString() : 'Never';
      const pending = status.pendingUploads || 0;
      alert(`Sync status: ${status.status}\nLast sync: ${lastSync}\nPending uploads: ${pending}\n\nClick OK to force a sync.`);
      if (window.electronAPI) window.electronAPI.forceSync();
    });

    document.body.appendChild(el);

    // Poll sync status
    async function pollStatus() {
      try {
        const status = await fetch(LOCAL_API + '/electron/sync-status').then(r => r.json());
        updateIndicator(status.status, status.isOnline);
      } catch {}
      setTimeout(pollStatus, 5000);
    }
    pollStatus();
  }

  // ── Init ────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    hookAuth();
    createSyncIndicator();
  });

  if (document.readyState !== 'loading') {
    hookAuth();
    setTimeout(createSyncIndicator, 500);
  }

  console.log('[Excelerate] Running in Electron mode. Local API:', LOCAL_API);
})();
