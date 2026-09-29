const { app, BrowserWindow, ipcMain, dialog, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PARTITION = 'persist:instagram';
const APP_ID = '936619743392459';
let panel = null;
let igWin = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (panel) { if (panel.isMinimized()) panel.restore(); panel.focus(); }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataFile = n => path.join(app.getPath('userData'), n);
const readJson = (n, fb) => { try { return JSON.parse(fs.readFileSync(dataFile(n), 'utf8')); } catch { return fb; } };
const writeJson = (n, v) => fs.writeFileSync(dataFile(n), JSON.stringify(v));
const loadHistory = () => readJson('history.json', []);
const saveHistory = h => writeJson('history.json', h.slice(-30));
const loadIgnored = () => readJson('ignored.json', []);
const lc = s => String(s || '').toLowerCase();

function progress(text, pct) {
  if (panel && !panel.isDestroyed()) panel.webContents.send('progress', { text, pct: typeof pct === 'number' ? pct : null });
}

function createPanel() {
  Menu.setApplicationMenu(null);
  panel = new BrowserWindow({
    width: 1020,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: 'IG Seguidores',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  panel.loadFile('index.html');
}

function openInstagram() {
  if (igWin && !igWin.isDestroyed()) { igWin.focus(); return; }
  igWin = new BrowserWindow({
    width: 1000,
    height: 820,
    title: 'Instagram',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { partition: PARTITION, contextIsolation: true }
  });
  igWin.webContents.setUserAgent(app.userAgentFallback.replace(/\s(Electron|ig-seguidores)\/\S+/g, ''));
  igWin.setMenuBarVisibility(false);
  igWin.loadURL('https://www.instagram.com/');
}

async function getCreds() {
  const ses = session.fromPartition(PARTITION);
  const cookies = await ses.cookies.get({ url: 'https://www.instagram.com' });
  const get = n => (cookies.find(c => c.name === n) || {}).value;
  return { userId: get('ds_user_id'), csrf: get('csrftoken') };
}

async function getCounts(userId) {
  try {
    if (!/^\d+$/.test(userId)) return null;
    const code = `(async () => {
      const r = await fetch('https://www.instagram.com/api/v1/users/${userId}/info/', {
        credentials: 'include',
        headers: { 'X-IG-App-ID': '${APP_ID}', 'X-Requested-With': 'XMLHttpRequest' }
      });
      return r.ok ? await r.json() : null;
    })()`;
    const d = await igWin.webContents.executeJavaScript(code);
    if (d && d.user) return { followers: d.user.follower_count, following: d.user.following_count };
  } catch { /* sin conteo: la barra queda sin porcentaje */ }
  return null;
}

async function fetchPage(type, userId, csrf, maxId) {
  const params = new URLSearchParams({ count: '50' });
  if (maxId) params.set('max_id', maxId);
  const url = `https://www.instagram.com/api/v1/friendships/${userId}/${type}/?${params}`;
  const code = `(async () => {
    const r = await fetch(${JSON.stringify(url)}, {
      credentials: 'include',
      headers: {
        'X-IG-App-ID': ${JSON.stringify(APP_ID)},
        'X-CSRFToken': ${JSON.stringify(csrf)},
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': '*/*'
      }
    });
    return { status: r.status, text: await r.text() };
  })()`;
  return igWin.webContents.executeJavaScript(code);
}

async function getAll(type, userId, csrf, total, base) {
  const users = [];
  let maxId = null;
  const label = type === 'following' ? 'seguidos' : 'seguidores';

  while (true) {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetchPage(type, userId, csrf, maxId);
      if (res.status === 429 && attempt < 3) {
        const wait = 60 * (attempt + 1);
        progress(`Instagram pidió esperar. Reintentando en ${wait} segundos...`);
        await sleep(wait * 1000);
        continue;
      }
      break;
    }
    if (res.status === 401 || res.status === 403 || /login_required/.test(res.text)) throw new Error('SESION');
    if (/checkpoint_required|challenge_required/.test(res.text)) throw new Error('CHECKPOINT');
    if (res.status !== 200) throw new Error(`Instagram respondió con el código ${res.status}.`);

    let data;
    try { data = JSON.parse(res.text); } catch { throw new Error('Instagram no devolvió datos válidos.'); }
    if (!data || !Array.isArray(data.users)) throw new Error('Instagram devolvió una respuesta inesperada.');

    users.push(...data.users);
    const pct = total ? base + 50 * Math.min(1, users.length / total) : null;
    progress(`Cargando ${label}: ${users.length}${total ? ' de ' + total : ''}`, pct);

    const next = data.next_max_id || null;
    if (!next || next === maxId) break;
    maxId = next;
    await sleep(1500 + Math.floor(Math.random() * 1500));
  }
  return users;
}

const flag = u => ({
  username: u.username,
  full_name: u.full_name || '',
  verified: !!u.is_verified,
  private: !!u.is_private
});

function scoreFollower(u) {
  if (u.is_verified) return null;
  const reasons = [];
  let score = 0;
  const name = String(u.username || '');
  if (u.has_anonymous_profile_picture) { score += 2; reasons.push('sin foto'); }
  if (!String(u.full_name || '').trim()) { score += 1; reasons.push('sin nombre'); }
  const digits = (name.match(/\d/g) || []).length;
  if (digits >= 4 || (name.length && digits / name.length > 0.4)) {
    score += 1;
    reasons.push('muchos números en el usuario');
  }
  return score >= 3
    ? { username: u.username, full_name: '', note: reasons.join(' · '), score, verified: false, private: !!u.is_private }
    : null;
}

function buildResult({ following, followers, source }) {
  const followerSet = new Set(followers.map(u => lc(u.username)).filter(Boolean));
  const followingSet = new Set(following.map(u => lc(u.username)).filter(Boolean));

  const seenA = new Set();
  const notFollowingBack = [];
  for (const u of following) {
    const n = lc(u.username);
    if (!n || seenA.has(n)) continue;
    seenA.add(n);
    if (!followerSet.has(n)) notFollowingBack.push(flag(u));
  }

  const seenB = new Set();
  const fans = [];
  for (const u of followers) {
    const n = lc(u.username);
    if (!n || seenB.has(n)) continue;
    seenB.add(n);
    if (!followingSet.has(n)) fans.push(flag(u));
  }

  const hasData = followers.some(u => typeof u.has_anonymous_profile_picture === 'boolean');
  const suspicious = hasData
    ? followers.map(scoreFollower).filter(Boolean).sort((x, y) => y.score - x.score)
    : null;

  const names = {};
  [...following, ...followers].forEach(u => {
    if (u.username && u.full_name) names[lc(u.username)] = u.full_name;
  });

  const history = loadHistory();
  const prev = history.length ? history[history.length - 1] : null;
  let unfollowedSinceLast = null;
  let newFollowers = null;
  if (prev) {
    const prevSet = new Set(prev.followers);
    const pn = prev.names || {};
    unfollowedSinceLast = prev.followers
      .filter(n => !followerSet.has(n) && followingSet.has(n))
      .map(username => ({ username, full_name: pn[username] || '' }));
    newFollowers = [...followerSet]
      .filter(n => !prevSet.has(n))
      .map(username => ({ username, full_name: names[username] || '' }));
  }

  history.push({
    date: new Date().toISOString(),
    source,
    followers: [...followerSet],
    following: [...followingSet],
    names
  });
  saveHistory(history);

  return {
    date: new Date().toISOString(),
    source,
    prevDate: prev ? prev.date : null,
    followingCount: followingSet.size,
    followersCount: followerSet.size,
    notFollowingBack,
    unfollowedSinceLast,
    newFollowers,
    fans,
    suspicious
  };
}

// ---------- IPC: análisis ----------
ipcMain.handle('open-instagram', () => { openInstagram(); return true; });

ipcMain.handle('analyze', async () => {
  try {
    if (!igWin || igWin.isDestroyed()) {
      openInstagram();
      return { error: 'Inicia sesión en la ventana de Instagram y después tocá "Analizar mi cuenta" de nuevo.' };
    }
    if (!igWin.webContents.getURL().startsWith('https://www.instagram.com')) {
      igWin.loadURL('https://www.instagram.com/');
      return { error: 'Esperá a que cargue Instagram y volvé a tocar "Analizar mi cuenta".' };
    }
    const { userId, csrf } = await getCreds();
    if (!userId || !csrf) {
      igWin.focus();
      return { error: 'No detecto tu sesión. Iniciá sesión en la ventana de Instagram y volvé a probar.' };
    }
    progress('Preparando análisis...', 0);
    const counts = await getCounts(userId);
    const following = await getAll('following', userId, csrf, counts && counts.following, 0);
    const followers = await getAll('followers', userId, csrf, counts && counts.followers, 50);
    progress('Listo.', 100);
    return buildResult({ following, followers, source: 'app' });
  } catch (e) {
    if (e.message === 'SESION') return { error: 'La sesión de Instagram venció. Tocá "Iniciar sesión en Instagram", entrá de nuevo y volvé a analizar.' };
    if (e.message === 'CHECKPOINT') return { error: 'Instagram pide verificar tu identidad. Abrí la ventana de Instagram, completá el paso pendiente y volvé a analizar.' };
    return { error: 'Error: ' + e.message };
  }
});

ipcMain.handle('import-export', async () => {
  try {
    const sel = await dialog.showOpenDialog(panel, {
      title: 'Elegí followers_1.json (y los demás followers_N) y following.json',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (sel.canceled || !sel.filePaths.length) return null;

    const followers = [];
    const following = [];
    const pick = it => {
      const s = (it.string_list_data && it.string_list_data[0]) || {};
      return { username: s.value || it.title || '', full_name: '' };
    };
    for (const f of sel.filePaths) {
      const name = path.basename(f).toLowerCase();
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (name.startsWith('following')) {
        (Array.isArray(data) ? data : (data.relationships_following || [])).forEach(it => following.push(pick(it)));
      } else if (name.startsWith('followers')) {
        (Array.isArray(data) ? data : (data.relationships_followers || [])).forEach(it => followers.push(pick(it)));
      }
    }
    if (!followers.length || !following.length) {
      return { error: 'Necesito al menos un archivo followers_*.json y uno following.json.' };
    }
    return buildResult({ following, followers, source: 'export' });
  } catch (e) {
    return { error: 'Error leyendo los archivos: ' + e.message };
  }
});

// ---------- IPC: historial, ignorados, comparación ----------
ipcMain.handle('get-history', () =>
  loadHistory().map(h => ({ date: h.date, followers: h.followers.length, following: h.following.length })));

ipcMain.handle('get-snapshots', () =>
  loadHistory().map((h, i) => ({ i, date: h.date, followers: h.followers.length, following: h.following.length })));

ipcMain.handle('compare', (_e, a, b) => {
  const h = loadHistory();
  let A = h[Math.min(a, b)];
  let B = h[Math.max(a, b)];
  if (!A || !B) return { error: 'No encontré esas fechas.' };
  const setA = new Set(A.followers);
  const setB = new Set(B.followers);
  const followingB = new Set(B.following);
  const nm = u => (B.names && B.names[u]) || (A.names && A.names[u]) || '';
  return {
    lost: A.followers.filter(u => !setB.has(u)).map(u => ({
      username: u, full_name: nm(u), note: followingB.has(u) ? 'todavía lo seguís' : ''
    })),
    gained: B.followers.filter(u => !setA.has(u)).map(u => ({ username: u, full_name: nm(u) }))
  };
});

ipcMain.handle('get-ignored', () => loadIgnored());
ipcMain.handle('toggle-ignore', (_e, username) => {
  const u = lc(username);
  let list = loadIgnored();
  list = list.includes(u) ? list.filter(x => x !== u) : [...list, u];
  writeJson('ignored.json', list);
  return list;
});

// ---------- IPC: exportar ----------
ipcMain.handle('save-json', async (_e, result) => {
  const r = await dialog.showSaveDialog(panel, {
    defaultPath: 'seguidores.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, JSON.stringify(result, null, 2));
  return true;
});

ipcMain.handle('export-csv', async (_e, { result: r, ignored }) => {
  const ign = new Set((ignored || []).map(lc));
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['lista', 'usuario', 'detalle']];
  const add = (label, arr) => (arr || []).forEach(u => rows.push([label, u.username, u.note || u.full_name || '']));
  add('No me siguen de vuelta', r.notFollowingBack.filter(u => !ign.has(lc(u.username))));
  add('Ignorados', r.notFollowingBack.filter(u => ign.has(lc(u.username))));
  add('Me dejaron de seguir', r.unfollowedSinceLast);
  add('Seguidores nuevos', r.newFollowers);
  add('Fans (me siguen y no sigo)', r.fans);
  add('Sospechosos', r.suspicious);
  const out = await dialog.showSaveDialog(panel, {
    defaultPath: 'seguidores.csv',
    filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }]
  });
  if (out.canceled) return false;
  fs.writeFileSync(out.filePath, '\uFEFF' + rows.map(x => x.map(esc).join(';')).join('\r\n'));
  return true;
});

ipcMain.handle('export-pdf', async (_e, { result: r, ignored, chart }) => {
  const out = await dialog.showSaveDialog(panel, {
    defaultPath: 'reporte-seguidores.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (out.canceled) return false;

  const ign = new Set((ignored || []).map(lc));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nfb = r.notFollowingBack.filter(u => !ign.has(lc(u.username)));
  const mutual = r.followingCount - r.notFollowingBack.length;
  const recip = r.followingCount ? Math.round(100 * mutual / r.followingCount) : 0;

  const section = (title, arr) => {
    if (!arr) return '';
    const items = arr.length
      ? arr.map(u => `<li>${esc(u.username)}${u.note ? ` <small>${esc(u.note)}</small>` : ''}</li>`).join('')
      : '<li><small>Sin cuentas</small></li>';
    return `<h2>${esc(title)} <span>${arr.length}</span></h2><ul>${items}</ul>`;
  };
  const card = (label, v) => `<div class="c"><b>${esc(v)}</b><i>${esc(label)}</i></div>`;

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><style>
    body{font:12px/1.5 "Segoe UI",system-ui,sans-serif;color:#1b1838;margin:0}
    header{background:linear-gradient(120deg,#4a35f0,#ff4f9a);color:#fff;padding:26px 30px}
    header h1{margin:0 0 4px;font-size:26px} header p{margin:0;opacity:.9}
    main{padding:20px 30px}
    .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}
    .c{border:1px solid #e2dff4;border-radius:12px;padding:10px 14px}
    .c b{display:block;font-size:22px} .c i{color:#6b688f;font-style:normal}
    h2{font-size:15px;margin:22px 0 8px;border-bottom:2px solid #e2dff4;padding-bottom:4px;break-after:avoid}
    h2 span{color:#6b4bff}
    ul{columns:3;column-gap:18px;margin:0;padding-left:16px}
    li{break-inside:avoid;margin:1px 0} small{color:#6b688f}
    img{width:100%;border:1px solid #e2dff4;border-radius:12px;margin:6px 0}
    footer{color:#6b688f;margin-top:24px;font-size:10px}
  </style></head><body>
  <header><h1>Reporte de seguidores</h1><p>Generado el ${esc(new Date(r.date).toLocaleString())}${r.source === 'demo' ? ' (datos de demostración)' : ''}</p></header>
  <main>
    <div class="cards">
      ${card('Seguidos', r.followingCount)}${card('Seguidores', r.followersCount)}${card('Reciprocidad', recip + '%')}
      ${card('No me siguen de vuelta', nfb.length)}${card('Me dejaron de seguir', r.unfollowedSinceLast ? r.unfollowedSinceLast.length : '—')}${card('Fans', r.fans ? r.fans.length : '—')}
    </div>
    ${chart ? `<h2>Evolución</h2><img src="${chart}">` : ''}
    ${section('No me siguen de vuelta', nfb)}
    ${section('Me dejaron de seguir', r.unfollowedSinceLast)}
    ${section('Seguidores nuevos', r.newFollowers)}
    ${section('Fans (me siguen y no sigo)', r.fans)}
    ${section('Cuentas sospechosas', r.suspicious)}
    <footer>IG Seguidores · Las cuentas sospechosas son una estimación, no una confirmación.</footer>
  </main></body></html>`;

  const tmp = path.join(os.tmpdir(), `ig-reporte-${Date.now()}.html`);
  fs.writeFileSync(tmp, html);
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(out.filePath, pdf);
  } finally {
    win.destroy();
    fs.rmSync(tmp, { force: true });
  }
  return true;
});

// ---------- IPC: varios ----------
ipcMain.handle('open-profile', (_e, username) => {
  if (/^[A-Za-z0-9._]{1,30}$/.test(username)) shell.openExternal(`https://www.instagram.com/${username}/`);
});

ipcMain.handle('logout', async () => {
  await session.fromPartition(PARTITION).clearStorageData();
  if (igWin && !igWin.isDestroyed()) igWin.close();
  return true;
});

ipcMain.handle('clear-history', async () => {
  const r = await dialog.showMessageBox(panel, {
    type: 'warning',
    buttons: ['Cancelar', 'Borrar'],
    defaultId: 0,
    cancelId: 0,
    message: '¿Borrar el historial y la lista de ignorados?',
    detail: 'Esta acción no se puede deshacer.'
  });
  if (r.response !== 1) return false;
  fs.rmSync(dataFile('history.json'), { force: true });
  fs.rmSync(dataFile('ignored.json'), { force: true });
  return true;
});

ipcMain.handle('about', () => ({ version: app.getVersion(), dataPath: app.getPath('userData') }));
ipcMain.handle('open-data-folder', () => shell.openPath(app.getPath('userData')));

ipcMain.handle('demo', () => {
  const mk = (prefix, n, extra = {}) =>
    Array.from({ length: n }, (_, i) => ({ username: `${prefix}_${i + 1}`, full_name: '', ...extra }));
  const history = Array.from({ length: 10 }, (_, i) => ({
    date: new Date(Date.now() - (9 - i) * 7 * 864e5).toISOString(),
    followers: 300 + i * 12 + (i % 3) * 4,
    following: 280 + i * 5
  }));
  const named = ['Valentina Ríos', 'Tomás Herrera', 'Camila Duarte', 'Joaquín Sosa', 'Martina Peralta', 'Lucía Benítez'];
  const nfb = mk('cuenta_demo', 14).map((u, i) => ({
    ...u,
    full_name: named[i % named.length],
    verified: i % 6 === 0,
    private: i % 4 === 1
  }));
  const result = {
    date: new Date().toISOString(),
    source: 'demo',
    prevDate: history[8].date,
    followingCount: history[9].following,
    followersCount: history[9].followers,
    notFollowingBack: nfb,
    unfollowedSinceLast: mk('ex_seguidor', 4),
    newFollowers: mk('nuevo', 9),
    fans: mk('fan_demo', 11).map((u, i) => ({ ...u, full_name: named[(i + 2) % named.length], private: i % 3 === 0 })),
    suspicious: [
      { username: 'user84729301', full_name: '', note: 'sin foto · sin nombre · muchos números en el usuario', score: 4 },
      { username: 'promo_ofertas88', full_name: '', note: 'sin foto · sin nombre', score: 3 },
      { username: 'x_93847261', full_name: '', note: 'sin foto · sin nombre · muchos números en el usuario', score: 4 }
    ]
  };
  return { result, history };
});

app.whenReady().then(createPanel);
app.on('window-all-closed', () => app.quit());
