const $ = id => document.getElementById(id);
const lc = s => String(s || '').toLowerCase();
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let result = null;
let historyData = [];
let ignored = new Set();
let tab = 'nfb';
let currentItems = [];
let isDemo = false;
const opts = { sort: 'default', hideVerified: false, hidePrivate: false, q: '' };

// ---------- tema ----------
(() => {
  const t = localStorage.getItem('theme');
  if (t) document.documentElement.dataset.theme = t;
})();
$('btnTheme').onclick = () => {
  const cur = document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  if (result && tab === 'stats') drawChart();
};

// ---------- progreso ----------
window.api.onProgress(p => {
  $('status').textContent = p.text;
  if (typeof p.pct === 'number') {
    $('bar').classList.remove('indet');
    $('bar').style.width = Math.max(0, Math.min(100, p.pct)) + '%';
  }
});

function setBusy(b) {
  ['btnRun', 'btnImport', 'btnLogin', 'btnDemo'].forEach(id => { $(id).disabled = b; });
  $('progress').hidden = !b;
  if (b) { $('bar').classList.add('indet'); $('bar').style.width = ''; }
}

async function run(fn) {
  setBusy(true);
  try {
    const r = await fn();
    if (!r) { /* cancelado */ }
    else if (r.error) $('status').textContent = r.error;
    else {
      if (r.result) { result = r.result; historyData = r.history; isDemo = true; }
      else { result = r; historyData = await window.api.getHistory(); isDemo = false; }
      ignored = new Set((await window.api.getIgnored()).map(lc));
      tab = 'nfb';
      ['btnSave', 'btnCsv', 'btnPdf'].forEach(id => { $(id).disabled = false; });
      const src = { export: 'export oficial', demo: 'modo demo, datos ficticios', app: 'app' }[result.source];
      $('status').textContent = `Análisis del ${new Date(result.date).toLocaleString()} (${src}).`;
      render();
    }
  } catch (e) {
    $('status').textContent = 'Error: ' + e.message;
  }
  setBusy(false);
}

// ---------- datos derivados ----------
function lists() {
  const r = result;
  return {
    nfb: r.notFollowingBack.filter(u => !ignored.has(lc(u.username))),
    ign: r.notFollowingBack.filter(u => ignored.has(lc(u.username))),
    unf: r.unfollowedSinceLast,
    new: r.newFollowers,
    fans: r.fans,
    sus: r.suspicious
  };
}

function tabsDef() {
  const L = lists();
  return [
    { id: 'nfb', label: 'No me siguen', items: L.nfb },
    { id: 'unf', label: 'Me dejaron', items: L.unf },
    { id: 'new', label: 'Nuevos', items: L.new },
    { id: 'fans', label: 'Fans', items: L.fans },
    { id: 'sus', label: 'Sospechosos', items: L.sus },
    { id: 'ign', label: 'Ignorados', items: L.ign },
    { id: 'cmp', label: 'Comparar', special: true },
    { id: 'stats', label: 'Gráfico', special: true }
  ];
}

function stat(label, value) {
  const d = el('div', 'stat');
  d.append(el('b', '', value), el('span', '', label));
  return d;
}

// ---------- render principal ----------
function render() {
  const r = result;
  const L = lists();
  const mutual = r.followingCount - r.notFollowingBack.length;
  const recip = r.followingCount ? Math.round(100 * mutual / r.followingCount) : 0;

  $('stats').replaceChildren(
    stat('Seguidos', r.followingCount),
    stat('Seguidores', r.followersCount),
    stat('No me siguen', L.nfb.length),
    stat('Me dejaron de seguir', L.unf ? L.unf.length : '—'),
    stat('Fans', L.fans ? L.fans.length : '—'),
    stat('Reciprocidad', recip + '%')
  );

  $('tabs').replaceChildren(...tabsDef().map(t => {
    const b = el('button', t.id === tab ? 'active' : '',
      t.special ? t.label : `${t.label} (${t.items ? t.items.length : '—'})`);
    b.onclick = () => { tab = t.id; render(); };
    return b;
  }));

  const isList = tab !== 'stats' && tab !== 'cmp';
  $('filterbar').hidden = !isList;
  $('list').hidden = !isList;
  $('chart').hidden = tab !== 'stats';
  $('compare').hidden = tab !== 'cmp';
  $('btnCopy').disabled = !isList;

  if (isList) renderList();
  else if (tab === 'stats') drawChart();
  else renderCompare();
}

function emptyRow(text) {
  return el('li', 'empty', text);
}

function buildRow(u, actions = []) {
  const li = el('li');
  const av = el('span', 'av', (u.username[0] || '?').toUpperCase());
  const info = el('span', 'info');
  info.append(el('b', '', u.username));
  const bits = [];
  const extra = u.note || u.full_name;
  if (extra) bits.push(extra);
  if (u.verified) bits.push('verificada');
  if (u.private) bits.push('privada');
  if (bits.length) info.append(el('small', '', bits.join(' · ')));

  const who = el('span', 'who');
  who.append(av, info);

  const box = el('span', 'rowactions');
  actions.forEach(a => {
    const b = el('button', 'link', a.label);
    b.onclick = a.fn;
    box.append(b);
  });
  const p = el('button', 'link', 'Ver perfil');
  p.onclick = () => window.api.openProfile(u.username);
  box.append(p);

  li.append(who, box);
  return li;
}

function applyView(items) {
  const q = opts.q.trim().toLowerCase();
  let out = items.filter(u =>
    (!opts.hideVerified || !u.verified) &&
    (!opts.hidePrivate || !u.private) &&
    (!q || u.username.toLowerCase().includes(q) ||
      (u.full_name || '').toLowerCase().includes(q) || (u.note || '').toLowerCase().includes(q)));
  if (opts.sort === 'az') out = [...out].sort((a, b) => a.username.localeCompare(b.username));
  if (opts.sort === 'za') out = [...out].sort((a, b) => b.username.localeCompare(a.username));
  return out;
}

async function toggleIgnore(u) {
  ignored = new Set((await window.api.toggleIgnore(u.username)).map(lc));
  render();
}

function renderList() {
  const t = tabsDef().find(x => x.id === tab);
  const ul = $('list');
  ul.replaceChildren();
  currentItems = [];

  if (!t.items) {
    ul.append(emptyRow(t.id === 'sus'
      ? 'Sin datos: la detección solo funciona al analizar desde la app, no con el export oficial.'
      : 'Es la primera vez: ya guardé tus seguidores. La próxima corrida voy a comparar contra hoy.'));
    return;
  }

  const items = applyView(t.items);
  currentItems = items;
  if (!items.length) {
    ul.append(emptyRow(t.id === 'ign' ? 'No ignoraste a nadie todavía.' : 'Nada para mostrar.'));
    return;
  }

  const actions = u =>
    t.id === 'nfb' ? [{ label: 'Ignorar', fn: () => toggleIgnore(u) }] :
    t.id === 'ign' ? [{ label: 'Quitar', fn: () => toggleIgnore(u) }] : [];

  items.forEach(u => ul.append(buildRow(u, actions(u))));
}

// ---------- comparar fechas ----------
async function renderCompare() {
  const selA = $('cmpA'), selB = $('cmpB');
  const listA = $('cmpListA'), listB = $('cmpListB');
  listA.replaceChildren(); listB.replaceChildren();
  $('cmpTitleA').textContent = 'Te dejaron de seguir';
  $('cmpTitleB').textContent = 'Te empezaron a seguir';

  const snaps = isDemo ? [] : await window.api.getSnapshots();
  selA.replaceChildren(); selB.replaceChildren();
  $('btnCmp').disabled = snaps.length < 2;

  if (snaps.length < 2) {
    const msg = isDemo
      ? 'El modo demo no guarda historial. Analizá tu cuenta al menos dos veces para comparar fechas.'
      : 'Necesitás al menos 2 análisis guardados para comparar fechas.';
    listA.append(emptyRow(msg));
    return;
  }
  snaps.forEach(s => {
    const label = `${new Date(s.date).toLocaleString()} (${s.followers} seguidores)`;
    const oa = el('option', '', label); oa.value = s.i;
    const ob = el('option', '', label); ob.value = s.i;
    selA.append(oa); selB.append(ob);
  });
  selA.value = snaps[snaps.length - 2].i;
  selB.value = snaps[snaps.length - 1].i;
  await doCompare();
}

async function doCompare() {
  const r = await window.api.compare(Number($('cmpA').value), Number($('cmpB').value));
  const fill = (ul, arr, empty) => {
    ul.replaceChildren();
    if (!arr || !arr.length) ul.append(emptyRow(empty));
    else arr.forEach(u => ul.append(buildRow(u)));
  };
  if (r.error) { fill($('cmpListA'), [], r.error); fill($('cmpListB'), [], ''); return; }
  $('cmpTitleA').textContent = `Te dejaron de seguir (${r.lost.length})`;
  $('cmpTitleB').textContent = `Te empezaron a seguir (${r.gained.length})`;
  fill($('cmpListA'), r.lost, 'Nadie en ese período.');
  fill($('cmpListB'), r.gained, 'Nadie en ese período.');
}

// ---------- gráfico ----------
function drawChart(print = false) {
  const c = $('chart');
  const ctx = c.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const mut = print ? '#6b688f' : cs.getPropertyValue('--mut').trim();
  const ac = print ? '#6b4bff' : cs.getPropertyValue('--ac').trim();
  const bd = print ? '#e2dff4' : cs.getPropertyValue('--bd').trim();
  const pts = historyData;

  ctx.clearRect(0, 0, c.width, c.height);
  if (print) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.font = '12px system-ui';
  ctx.fillStyle = mut;

  if (pts.length < 2) {
    ctx.fillText('Necesitás al menos 2 análisis para ver la evolución.', 20, 40);
    return;
  }

  const L = 50, R = 20, T = 34, B = 32;
  const W = c.width - L - R, H = c.height - T - B;
  const all = pts.flatMap(p => [p.followers, p.following]);
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  const x = i => L + W * i / (pts.length - 1);
  const y = v => T + H * (1 - (v - min) / (max - min));

  ctx.strokeStyle = bd;
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = min + (max - min) * g / 4;
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(L + W, yy); ctx.stroke();
    ctx.fillStyle = mut;
    ctx.fillText(String(Math.round(v)), 8, yy + 4);
  }

  const line = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p[key])) : ctx.moveTo(x(i), y(p[key]))));
    ctx.stroke();
    ctx.fillStyle = color;
    pts.forEach((p, i) => { ctx.beginPath(); ctx.arc(x(i), y(p[key]), 3, 0, Math.PI * 2); ctx.fill(); });
  };
  const AMBER = '#f59e0b';
  line('followers', ac);
  line('following', AMBER);

  ctx.fillStyle = ac;    ctx.fillText('● Seguidores', L, 18);
  ctx.fillStyle = AMBER; ctx.fillText('● Seguidos', L + 100, 18);

  ctx.fillStyle = mut;
  const fmt = d => new Date(d).toLocaleDateString();
  ctx.fillText(fmt(pts[0].date), L, c.height - 10);
  const last = fmt(pts[pts.length - 1].date);
  ctx.fillText(last, L + W - ctx.measureText(last).width, c.height - 10);
}

// ---------- controles ----------
$('filter').oninput = e => { opts.q = e.target.value; renderList(); };
$('sort').onchange = e => { opts.sort = e.target.value; renderList(); };
$('hideVerified').onchange = e => { opts.hideVerified = e.target.checked; renderList(); };
$('hidePrivate').onchange = e => { opts.hidePrivate = e.target.checked; renderList(); };
$('btnCmp').onclick = doCompare;

$('btnLogin').onclick = () => window.api.openInstagram();
$('btnRun').onclick = () => run(() => window.api.analyze());
$('btnImport').onclick = () => run(() => window.api.importExport());
$('btnDemo').onclick = () => run(() => window.api.demo());

const payload = () => ({ result, ignored: [...ignored] });
$('btnCsv').onclick = () => result && window.api.exportCsv(payload());
$('btnSave').onclick = () => result && window.api.saveJson(result);
$('btnPdf').onclick = async () => {
  if (!result) return;
  let chart = null;
  if (historyData.length >= 2) { drawChart(true); chart = $('chart').toDataURL('image/png'); }
  if (tab === 'stats') drawChart();
  await window.api.exportPdf({ ...payload(), chart });
};
$('btnCopy').onclick = async () => {
  if (!currentItems.length) { $('status').textContent = 'No hay cuentas para copiar en esta lista.'; return; }
  try {
    await navigator.clipboard.writeText(currentItems.map(u => u.username).join('\n'));
    $('status').textContent = `Copié ${currentItems.length} cuentas al portapapeles.`;
  } catch {
    $('status').textContent = 'No pude copiar al portapapeles.';
  }
};

// ---------- pie ----------
$('btnLogout').onclick = async () => {
  await window.api.logout();
  $('status').textContent = 'Cerraste la sesión de Instagram en esta app.';
};
$('btnWipe').onclick = async () => {
  if (await window.api.clearHistory()) {
    ignored = new Set();
    historyData = [];
    $('status').textContent = 'Historial borrado.';
    if (result) render();
  }
};
$('btnFolder').onclick = () => window.api.openDataFolder();
window.api.about().then(a => { $('ver').textContent = 'Versión ' + a.version; });

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !$('filterbar').hidden) {
    e.preventDefault();
    $('filter').focus();
  }
});
