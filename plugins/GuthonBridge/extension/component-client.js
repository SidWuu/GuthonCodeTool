(function(root) {
  let pending;
  async function heartbeat({ chrome, request, clientId, fetchFile = fetch }) {
    if (pending) return pending;
    pending = (async () => {
      let installId = '', installedVersion = '', installedBuildId = '';
      try {
        const response = await fetchFile(chrome.runtime.getURL('managed-install.json'));
        if (response.ok) {
          const marker = await response.json();
          installId = marker.installId || ''; installedVersion = marker.version || '';
          installedBuildId = marker.sourceBuildId || '';
        }
      } catch { /* Unmanaged installations have no local marker. */ }
      const manifest = chrome.runtime.getManifest();
      const reply = await request('/componentHeartbeat', { clientId: await clientId(),
        extensionId: chrome.runtime.id, version: manifest.version, protocolVersion: 2, installId,
        sourceBuildId: root.GuthonBridgeSourceBuildId || '' });
      const changed = reply.targetVersion !== manifest.version || (reply.targetBuildId && reply.targetBuildId === installedBuildId && reply.targetBuildId !== root.GuthonBridgeSourceBuildId);
      if (reply.reload && installId && reply.targetVersion === installedVersion && /^\d+\.\d+\.\d+$/.test(reply.targetVersion || '') && changed) {
        const records = await chrome.storage.local.get('guthonBridgePendingJobs');
        // Unknown or running writes must be resolved by the user before reload.
        if (Object.keys(records.guthonBridgePendingJobs || {}).length) return { ...reply, reloadDeferred: true };
        chrome.runtime.reload();
      }
      return reply;
    })();
    try { return await pending; } finally { pending = undefined; }
  }
  root.GuthonBridgeComponents = { heartbeat };
  if (typeof module === 'object' && module.exports) module.exports = { heartbeat };
})(globalThis);
