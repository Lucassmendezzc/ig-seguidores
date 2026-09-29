const { contextBridge, ipcRenderer } = require('electron');
const call = ch => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  openInstagram: call('open-instagram'),
  analyze: call('analyze'),
  importExport: call('import-export'),
  demo: call('demo'),
  getHistory: call('get-history'),
  getSnapshots: call('get-snapshots'),
  compare: call('compare'),
  getIgnored: call('get-ignored'),
  toggleIgnore: call('toggle-ignore'),
  saveJson: call('save-json'),
  exportCsv: call('export-csv'),
  exportPdf: call('export-pdf'),
  openProfile: call('open-profile'),
  logout: call('logout'),
  clearHistory: call('clear-history'),
  about: call('about'),
  openDataFolder: call('open-data-folder'),
  onProgress: cb => ipcRenderer.on('progress', (_e, p) => cb(p))
});
