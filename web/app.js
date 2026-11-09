'use strict';
// ---------- yardımcılar ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TL = (n) => Number(n || 0).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' ₺';
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fdate = (d) => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) : '';
const METHOD = { cash: 'Elden', eft: 'EFT', other: 'Diğer' };

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- API istemcisi ----------
const store = {
  get: () => JSON.parse(localStorage.getItem('auth') || 'null'),
  set: (v) => v ? localStorage.setItem('auth', JSON.stringify(v)) : localStorage.removeItem('auth'),
};
async function api(path, opts = {}, retry = true) {
  const a = store.get();
  const res = await fetch('/api/v1' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(a ? { Authorization: 'Bearer ' + a.accessToken } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && a && retry && path !== '/auth/login') {
    const r = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: a.refreshToken }) });
    if (r.ok) { a.accessToken = (await r.json()).data.accessToken; store.set(a); return api(path, opts, false); }
    logout(); throw new Error('Oturum süresi doldu');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || 'Hata oluştu');
  return j;
}
const post = (p, body) => api(p, { method: 'POST', body });
const put = (p, body) => api(p, { method: 'PUT', body });
const del = (p) => api(p, { method: 'DELETE' });
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast('⚠ ' + e.message); } };

function logout() { store.set(null); location.hash = '#/login'; render(); }

// ---------- bottom sheet ----------
function sheet(html, onMount) {
  closeSheet();
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  bg.addEventListener('click', (e) => { if (e.target === bg) closeSheet(); });
  document.body.appendChild(bg);
  onMount && onMount(bg.firstChild);
  return bg.firstChild;
}
function closeSheet() { document.querySelectorAll('.sheet-bg').forEach((e) => e.remove()); }

// ---------- iskelet ----------
const TABS = [['home', '🏠', 'Ana Sayfa'], ['attendance', '✅', 'Yoklama'], ['students', '👦', 'Öğrenciler'], ['finance', '💰', 'Finans'], ['notify', '📣', 'Mesaj']];
let me = null;

function shell(title, body, tab) {
  const tabs = TABS.filter((t) => t[0] !== 'finance' || me.canSeeFinance);
  $('#app').innerHTML = `
    <header class="top"><h1>${esc(title)}</h1><button data-act="logout">${esc(me.fullName)} · Çıkış</button></header>
    <main>${body}</main>
    <nav class="bottom"><div>${tabs.map(([k, i, l]) => `<a href="#/${k}" class="${k === tab ? 'on' : ''}"><span>${i}</span>${l}</a>`).join('')}</div></nav>`;
}

// ---------- ROUTER ----------
async function render() {
  closeSheet();
  const route = (location.hash || '#/home').slice(2).split('/');
  if (!store.get()) return loginView();
  if (!me) { try { me = (await api('/auth/me')).data; } catch { return loginView(); } }
  window.scrollTo(0, 0);
  $('#app').innerHTML = '<main><p class="empty">Yükleniyor…</p></main>';
  try {
    const views = { home: homeView, attendance: attendanceView, students: studentsView, student: studentView, finance: financeView, notify: notifyView };
    await (views[route[0]] || homeView)(route[1]);
  } catch (e) { toast('⚠ ' + e.message); $('#app').innerHTML = `<main><p class="empty">Yüklenemedi: ${esc(e.message)}</p></main>`; }
}
window.addEventListener('hashchange', render);

// ---------- giriş ----------
function loginView() {
  $('#app').innerHTML = `
  <div class="login"><h1>⚽ Spor Okulu</h1><p class="mu">Yönetim Paneli</p>
    <form id="lf">
      <label>E-posta</label><input name="email" type="email" autocomplete="username" required value="admin@demo.com">
      <label>Şifre</label><input name="password" type="password" autocomplete="current-password" required value="demo1234">
      <p></p><button class="btn">Giriş yap</button>
    </form>
    <div class="hint"><b>Deneme hesapları</b> (demo veri)<br>Yönetici: admin@demo.com / demo1234<br>Antrenör: coach@demo.com / demo1234</div>
  </div>`;
  $('#lf').onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = await post('/auth/login', { email: f.get('email'), password: f.get('password') });
    store.set(r.data); me = null; location.hash = '#/home'; render();
  });
}

// ---------- ANA SAYFA ----------
async function homeView() {
  const d = (await api('/dashboard/summary')).data;
  const sess = d.today.sessions.map((s) => `
    <div class="card row">
      <div class="col"><span class="b">${esc(s.groupName)}</span><span class="mu sm">${esc(s.schedule || '')}</span></div>
      ${s.cancelled ? '<span class="badge rd">İptal</span>'
        : s.attendanceTaken ? `<a class="btn sec sm" href="#/attendance/${s.groupId}">✔ Alındı</a>`
        : `<a class="btn sm" href="#/attendance/${s.groupId}">Yoklama Al ▶</a>`}
    </div>`).join('');
  const f = d.finance;
  const fin = f ? `
    <h2>Bu Ay</h2>
    <div class="card">
      <div class="row"><span class="mu">Tahsilat</span><span class="b gn">${TL(f.monthCollected)}</span></div>
      <div class="row"><span class="mu">Gider</span><span class="b">${TL(f.monthExpenses)}</span></div>
      <div class="row"><span class="mu">Toplam borç (${f.debtorCount} kişi)</span><span class="b rd">${TL(f.totalDebt)}</span></div>
    </div>
    <h2>Borçlular</h2>
    <div class="card">${d.topDebtors.map((x) => `
      <div class="list-item">
        <div class="col"><span class="b">${esc(x.name)}</span><span class="mu sm">${esc(x.groupName || '')} · <span class="rd">${TL(x.debt)}</span>${x.overdueDays ? ` · ${x.overdueDays} gün` : ''}</span></div>
        <div class="row">${x.guardianPhone ? `<a class="ibtn" href="tel:${esc(x.guardianPhone)}">📞</a>` : ''}
        ${me.role === 'admin' ? `<button class="ibtn" data-act="pay" data-id="${x.studentId}" data-name="${esc(x.name)}">💵</button>` : ''}</div>
      </div>`).join('') || '<p class="empty">Borçlu yok 🎉</p>'}
      <a class="btn sec" href="#/finance">Tümü ▶</a>
    </div>` : '';
  const quick = me.role === 'admin' ? `
    <div class="grid2">
      <button class="quick" data-act="pay"><span>💵</span>Tahsilat</button>
      <button class="quick" data-act="expense"><span>🧾</span>Gider</button>
      <button class="quick" data-act="goto" data-to="attendance"><span>✅</span>Yoklama</button>
      <button class="quick" data-act="goto" data-to="notify"><span>📣</span>İptal Duyur</button>
    </div>` : `
    <div class="grid2">
      <button class="quick" data-act="goto" data-to="attendance"><span>✅</span>Yoklama</button>
      <button class="quick" data-act="goto" data-to="notify"><span>📣</span>İptal Duyur</button>
    </div>`;
  shell('Merhaba ' + me.fullName.split(' ').slice(-1)[0], `<h2>Bugün</h2>${sess}<h2>Hızlı işlem</h2>${quick}${fin}`, 'home');
}

// ---------- YOKLAMA ----------
const ORDER = ['present', 'absent', 'late', 'excused'];
const ST = { present: ['✅ Geldi', 'present'], absent: ['❌ Gelmedi', 'absent'], late: ['🕒 Geç', 'late'], excused: ['📝 İzinli', 'excused'] };
let att = null;

async function attendanceView(groupId) {
  const groups = (await api('/groups')).data;
  att = att && att.groupId === groupId && att.date ? att : { groupId, date: today() };
  att.groupId = groupId || att.groupId || groups[0]?.id;
  const chips = groups.map((g) => `<button class="chip ${g.id === att.groupId ? 'on' : ''}" data-act="attgroup" data-id="${g.id}">${esc(g.name)}</button>`).join('');
  shell('Yoklama', `<div class="chips">${chips}</div>
    <input type="date" id="attdate" value="${att.date}" style="margin-bottom:10px"><div id="attbody"></div>`, 'attendance');
  $('#attdate').onchange = (e) => { att.date = e.target.value || today(); loadAtt(); };
  loadAtt();
}
async function loadAtt() {
  const box = $('#attbody');
  if (!att.groupId) { box.innerHTML = '<p class="empty">Bir grup seçin</p>'; return; }
  box.innerHTML = '<p class="empty">Yükleniyor…</p>';
  const s = (await post('/sessions', { groupId: att.groupId, sessionDate: att.date })).data;
  const d = (await api(`/sessions/${s.sessionId}/attendance`)).data;
  att.sessionId = d.sessionId;
  att.students = d.students.map((x) => ({ ...x, status: x.status || 'present', saved: !!x.status }));
  drawAtt();
}
function drawAtt() {
  const box = $('#attbody');
  if (!att.students.length) { box.innerHTML = '<p class="empty">Bu grupta öğrenci yok</p>'; return; }
  const c = (s) => att.students.filter((x) => x.status === s).length;
  box.innerHTML = `
    <div class="row" style="margin-bottom:10px"><span class="mu">${att.students.length} öğrenci</span>
      <button class="btn sec sm" data-act="allpresent">Hepsi geldi</button></div>
    ${att.students.map((x, i) => `
      <button class="att ${x.status}" data-act="cycle" data-i="${i}">
        <span>${esc(x.name)} ${x.healthAlert ? '<span class="badge am" data-act="health" data-i="' + i + '">⚠</span>' : ''}</span>
        <span class="st">${ST[x.status][0]}</span></button>`).join('')}
    <div style="height:70px"></div>
    <div class="savebar"><button class="btn" data-act="saveatt">Kaydet (${c('present')} ✔ / ${c('absent')} ❌${c('late') ? ' / ' + c('late') + ' 🕒' : ''}${c('excused') ? ' / ' + c('excused') + ' 📝' : ''})</button></div>`;
}

// ---------- ÖĞRENCİLER ----------
let sf = { q: '', groupId: '', hasDebt: false };
async function studentsView() {
  const groups = (await api('/groups')).data;
  shell('Öğrenciler', `
    <input id="q" placeholder="🔍 Öğrenci ara…" value="${esc(sf.q)}">
    <div class="chips" style="margin-top:10px">
      <button class="chip ${!sf.groupId ? 'on' : ''}" data-act="sgroup" data-id="">Tümü</button>
      ${groups.map((g) => `<button class="chip ${sf.groupId === g.id ? 'on' : ''}" data-act="sgroup" data-id="${g.id}">${esc(g.name.split(' ')[0])} (${g.studentCount})</button>`).join('')}
      ${me.canSeeFinance ? `<button class="chip ${sf.hasDebt ? 'on' : ''}" data-act="sdebt">🔴 Borçlu</button>` : ''}
    </div>
    ${me.role === 'admin' ? '<button class="btn sec" data-act="addstudent" style="margin-bottom:10px">+ Yeni öğrenci</button>' : ''}
    <div id="slist"></div>`, 'students');
  let t;
  $('#q').oninput = (e) => { sf.q = e.target.value; clearTimeout(t); t = setTimeout(loadStudents, 250); };
  window._groups = groups;
  loadStudents();
}
async function loadStudents() {
  const p = new URLSearchParams({ limit: 100 });
  if (sf.q) p.set('q', sf.q); if (sf.groupId) p.set('groupId', sf.groupId); if (sf.hasDebt) p.set('hasDebt', 'true');
  const r = await api('/students?' + p);
  const box = $('#slist'); if (!box) return;
  box.innerHTML = r.data.map((s) => `
    <a href="#/student/${s.id}" class="card row" style="text-decoration:none;color:inherit">
      <div class="col"><span class="b">${esc(s.firstName)} ${esc(s.lastName)}</span><span class="mu sm">${s.age} yaş · ${esc(s.groupName || '-')}</span></div>
      <div class="row">${s.debt > 0 ? `<span class="badge rd">${TL(s.debt)}</span>` : ''}${s.hasHealthAlert ? '<span class="badge am">⚠</span>' : ''}</div>
    </a>`).join('') || '<p class="empty">Sonuç yok</p>';
}

async function studentView(id) {
  const s = (await api('/students/' + id)).data;
  const [hist, ] = await Promise.all([api(`/students/${id}/attendance`)]);
  const h = s.health;
  const hasH = h.notes || h.allergies;
  const gl = s.guardians.map((g) => `
    <div class="list-item"><div class="col"><span class="b">${esc(g.fullName)}</span><span class="mu sm">${esc(g.relation || '')} · ${esc(g.phone)}</span></div>
    <a class="ibtn" href="tel:${esc(g.phone)}">📞</a></div>`).join('');
  const bal = s.balance ? `
    <h2>Aidat</h2><div class="card">
      <div class="row"><span class="mu">Toplam tahakkuk</span><span>${TL(s.balance.charged)}</span></div>
      <div class="row"><span class="mu">Ödenen</span><span class="gn">${TL(s.balance.paid)}</span></div>
      <div class="row"><span class="mu">Kalan borç</span><span class="b ${s.balance.debt > 0 ? 'rd' : ''}">${TL(s.balance.debt)}</span></div>
      ${me.role === 'admin' && s.balance.debt > 0 ? `<p></p><button class="btn" data-act="pay" data-id="${s.id}" data-name="${esc(s.firstName + ' ' + s.lastName)}">💵 Tahsilat al</button>` : ''}
      ${s.payments?.length ? '<p class="mu sm">Son ödemeler</p>' + s.payments.map((p) => `<div class="row sm"><span>${fdate(p.paidAt)} · ${METHOD[p.method]}</span><span>${TL(p.amount)}</span></div>`).join('') : ''}
    </div>` : '';
  shell(s.firstName + ' ' + s.lastName, `
    <a href="#/students" class="mu">‹ Geri</a>
    <div class="card" style="margin-top:8px"><div class="b big">${esc(s.firstName)} ${esc(s.lastName)}</div>
      <div class="mu">${s.age} yaş · ${esc(s.group?.name || 'Grupsuz')}${s.attendanceRate30d != null ? ` · Devam %${Math.round(s.attendanceRate30d * 100)}` : ''}</div></div>
    <div class="emerg"><div class="b rd">🚑 ACİL DURUM</div>
      <p class="sm" style="margin:6px 0 0"><b>Alerji:</b> ${esc(h.allergies || 'Yok')}<br><b>Kronik rahatsızlık:</b> ${esc(h.notes || 'Yok')}<br><b>Kan grubu:</b> ${esc(h.bloodType || '-')}</p>
      ${gl}</div>
    ${bal}
    <h2>Son yoklamalar</h2><div class="card">${hist.data.slice(0, 8).map((a) => `<div class="row sm" style="padding:4px 0"><span>${fdate(a.date)}</span><span>${ST[a.status][0]}</span></div>`).join('') || '<p class="empty">Kayıt yok</p>'}</div>
    ${me.role === 'admin' ? `<button class="btn sec red" style="background:#fee2e2;color:#dc2626" data-act="delstudent" data-id="${s.id}">Öğrenciyi pasife al</button>` : ''}
    `, 'students');
}

// ---------- FİNANS ----------
let ftab = 'debtors';
async function financeView() {
  if (!me.canSeeFinance) { location.hash = '#/home'; return; }
  shell('Finans', `
    <div class="tabs">${[['debtors', 'Borçlular'], ['payments', 'Tahsilat'], ['expenses', 'Gider'], ['report', 'Rapor']]
      .map(([k, l]) => `<button class="${ftab === k ? 'on' : ''}" data-act="ftab" data-k="${k}">${l}</button>`).join('')}</div>
    ${me.role === 'admin' ? '<div class="grid2" style="margin-bottom:12px"><button class="btn" data-act="pay">💵 Tahsilat</button><button class="btn sec" data-act="expense">🧾 Gider</button></div>' : ''}
    <div id="fbody"></div>`, 'finance');
  loadFinance();
}
async function loadFinance() {
  const box = $('#fbody');
  if (ftab === 'debtors') {
    const r = await api('/finance/debtors?limit=100');
    box.innerHTML = `<div class="card row"><span class="mu">${r.meta.count} borçlu</span><span class="b rd">${TL(r.meta.totalDebt)}</span></div>
      ${me.role === 'admin' && r.meta.count ? '<button class="btn sec" data-act="remindall" style="margin-bottom:10px">📣 Tüm borçlulara hatırlat</button>' : ''}
      ${r.data.map((x) => `<div class="card row">
        <div class="col"><span class="b">${esc(x.name)}</span><span class="mu sm">${esc(x.groupName || '')} · <span class="rd b">${TL(x.debt)}</span>${x.overdueDays ? ` · ${x.overdueDays} gün gecikme` : ''}</span></div>
        <div class="row">${x.guardianPhone ? `<a class="ibtn" href="tel:${esc(x.guardianPhone)}">📞</a>` : ''}
        ${me.role === 'admin' ? `<button class="ibtn" data-act="pay" data-id="${x.studentId}" data-name="${esc(x.name)}">💵</button>` : ''}</div></div>`).join('') || '<p class="empty">Borçlu yok 🎉</p>'}`;
  } else if (ftab === 'payments') {
    const r = await api('/finance/payments?limit=50');
    box.innerHTML = r.data.map((p) => `<div class="card row">
      <div class="col"><span class="b">${esc(p.studentName)}</span><span class="mu sm">${fdate(p.paidAt)} · ${METHOD[p.method]}</span></div>
      <div class="row"><span class="b gn">${TL(p.amount)}</span>${me.role === 'admin' ? `<button class="ibtn" data-act="voidpay" data-id="${p.id}">↩</button>` : ''}</div></div>`).join('') || '<p class="empty">Kayıt yok</p>';
  } else if (ftab === 'expenses') {
    const r = await api('/finance/expenses');
    box.innerHTML = r.data.map((x) => `<div class="card row">
      <div class="col"><span class="b">${esc(x.category)}</span><span class="mu sm">${fdate(x.spentAt)} ${esc(x.description || '')}</span></div>
      <div class="row"><span class="b">${TL(x.amount)}</span>${me.role === 'admin' ? `<button class="ibtn" data-act="voidexp" data-id="${x.id}">↩</button>` : ''}</div></div>`).join('') || '<p class="empty">Kayıt yok</p>';
  } else {
    const m = today().slice(0, 7);
    const r = (await api('/finance/report?month=' + m)).data;
    box.innerHTML = `<div class="card"><div class="mu">${m}</div>
      <div class="row"><span>Gelir</span><span class="b gn">${TL(r.income)}</span></div>
      <div class="row"><span>Gider</span><span class="b">${TL(r.expense)}</span></div>
      <div class="row"><span class="b">Net</span><span class="big ${r.net < 0 ? 'rd' : 'gn'}">${TL(r.net)}</span></div></div>
      ${r.expensesByCategory.map((c) => `<div class="row sm" style="padding:4px 8px"><span>${esc(c.category)}</span><span>${TL(c.total)}</span></div>`).join('')}
      ${me.role === 'admin' ? `<p></p><button class="btn sec" data-act="gencharges">Bu ayın aidatlarını oluştur</button>` : ''}`;
  }
}

function paySheet(pre) {
  const el = sheet(`
    <h3>💵 Tahsilat</h3>
    <label>Öğrenci</label>
    <input id="ps" placeholder="Öğrenci ara…" value="${esc(pre?.name || '')}" ${pre ? 'data-id="' + pre.id + '"' : ''} autocomplete="off">
    <div id="psr"></div>
    <div id="pdebt" class="mu sm"></div>
    <label>Tutar (₺)</label><input id="pa" inputmode="decimal" placeholder="0" style="font-size:26px;text-align:center">
    <p><button class="btn sec sm" id="pall" type="button">Tüm borç</button></p>
    <label>Yöntem</label>
    <div class="seg"><button class="chip on" data-m="cash">💵 Elden</button><button class="chip" data-m="eft">🏦 EFT</button></div>
    <label>Not / dekont no (isteğe bağlı)</label><input id="pn">
    <p></p><button class="btn" id="psave">Kaydet</button>`, (root) => {
    let method = 'cash', debt = 0, sid = pre?.id || null;
    const ps = $('#ps', root), box = $('#psr', root);
    const loadDebt = guard(async () => {
      if (!sid) return;
      const s = (await api('/students/' + sid)).data;
      debt = s.balance?.debt || 0;
      $('#pdebt', root).innerHTML = `Kalan borç: <b class="${debt > 0 ? 'rd' : ''}">${TL(debt)}</b>`;
    });
    loadDebt();
    let t;
    ps.oninput = () => {
      sid = null; clearTimeout(t);
      t = setTimeout(guard(async () => {
        if (ps.value.length < 2) { box.innerHTML = ''; return; }
        const r = await api('/students?limit=6&q=' + encodeURIComponent(ps.value));
        box.innerHTML = r.data.map((s) => `<div class="list-item" data-pick="${s.id}" data-name="${esc(s.firstName + ' ' + s.lastName)}"><span>${esc(s.firstName)} ${esc(s.lastName)} <span class="mu sm">${esc(s.groupName || '')}</span></span><span class="badge ${s.debt > 0 ? 'rd' : ''}">${TL(s.debt)}</span></div>`).join('');
      }), 250);
    };
    box.onclick = (e) => {
      const it = e.target.closest('[data-pick]'); if (!it) return;
      sid = it.dataset.pick; ps.value = it.dataset.name; box.innerHTML = ''; loadDebt();
    };
    root.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => {
      method = b.dataset.m; root.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
    });
    $('#pall', root).onclick = () => { $('#pa', root).value = debt; };
    $('#psave', root).onclick = guard(async () => {
      const amount = Number(String($('#pa', root).value).replace(',', '.'));
      if (!sid) return toast('Listeden bir öğrenci seçin');
      if (!(amount > 0)) return toast('Tutar girin');
      const r = await post('/finance/payments', { studentId: sid, amount, method, note: $('#pn', root).value || undefined });
      closeSheet(); toast(`✔ ${TL(amount)} kaydedildi · kalan ${TL(r.data.remainingDebt)}`); render();
    });
  });
  return el;
}
function expenseSheet() {
  sheet(`<h3>🧾 Gider</h3>
    <label>Kategori</label>
    <div class="chips" id="ecat">${['Saha kirası', 'Su', 'Ekipman', 'Maaş', 'Diğer'].map((c, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-c="${c}">${c}</button>`).join('')}</div>
    <label>Tutar (₺)</label><input id="ea" inputmode="decimal" placeholder="0" style="font-size:26px;text-align:center">
    <label>Açıklama (isteğe bağlı)</label><input id="ed">
    <p></p><button class="btn" id="esave">Kaydet</button>`, (root) => {
    let cat = 'Saha kirası';
    root.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => { cat = b.dataset.c; root.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b)); });
    $('#esave', root).onclick = guard(async () => {
      const amount = Number(String($('#ea', root).value).replace(',', '.'));
      if (!(amount > 0)) return toast('Tutar girin');
      await post('/finance/expenses', { category: cat, amount, description: $('#ed', root).value || undefined });
      closeSheet(); toast('✔ Gider kaydedildi'); render();
    });
  });
}

function studentSheet() {
  const groups = window._groups || [];
  sheet(`<h3>Yeni öğrenci</h3>
    <label>Ad</label><input id="n1"><label>Soyad</label><input id="n2">
    <label>Doğum tarihi</label><input id="n3" type="date">
    <label>Grup</label><select id="n4">${groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>
    <label>Alerji</label><input id="n5"><label>Kronik rahatsızlık</label><input id="n6">
    <label>Veli adı</label><input id="n7"><label>Veli telefonu (+90…)</label><input id="n8" inputmode="tel" value="+90">
    <p></p><button class="btn" id="nsave">Kaydet</button>`, (root) => {
    $('#nsave', root).onclick = guard(async () => {
      const v = (i) => $('#' + i, root).value.trim();
      await post('/students', { firstName: v('n1'), lastName: v('n2'), birthDate: v('n3'), groupId: v('n4') || null,
        allergies: v('n5') || null, healthNotes: v('n6') || null,
        guardians: v('n7') ? [{ fullName: v('n7'), phone: v('n8'), relation: 'veli', isPrimary: true }] : [] });
      closeSheet(); toast('✔ Öğrenci eklendi'); render();
    });
  });
}

// ---------- MESAJ ----------
const TPL = {
  cancel: { title: '🚫 Antrenman İptali', path: '/notifications/training-cancel', fields: ['date', 'reason'] },
  time: { title: '🕒 Saat Değişikliği', path: '/notifications/time-change', fields: ['date', 'time'] },
  custom: { title: '✏️ Serbest Mesaj', path: '/notifications/custom', fields: ['msg'] },
  fee: { title: '💳 Aidat Hatırlatma', path: '/notifications/fee-reminder', fields: [] },
};
async function notifyView() {
  const [groups, hist] = await Promise.all([api('/groups'), api('/notifications?limit=15')]);
  window._groups = groups.data;
  const st = { sent: ['Gönderildi', 'gn'], failed: ['Başarısız', 'rd'], pending: ['Bekliyor', 'am'], sending: ['Gönderiliyor', 'am'] };
  shell('Mesaj Merkezi', `
    <div class="grid2">${Object.entries(TPL).filter(([k]) => k !== 'fee' || me.canSeeFinance).map(([k, t]) => `<button class="quick" data-act="tpl" data-k="${k}">${t.title}</button>`).join('')}</div>
    <h2>Gönderim geçmişi <span class="mu">(${hist.meta.sent} ✔ · ${hist.meta.pending} ⏳ · ${hist.meta.failed} ✖)</span></h2>
    ${hist.data.map((n) => `<div class="card"><div class="row"><span class="badge ${st[n.status][1]}">${st[n.status][0]}</span><span class="mu sm">${n.channel} · ${esc(n.phone || '')}</span></div>
      <div class="sm" style="margin-top:6px">${esc(n.message)}</div>${n.error ? `<div class="mu sm">${esc(n.error)}</div>` : ''}
      ${n.status === 'failed' ? `<p></p><button class="btn sec sm" data-act="retry" data-id="${n.id}">Tekrar dene</button>` : ''}</div>`).join('') || '<p class="empty">Henüz mesaj yok</p>'}`, 'notify');
}
function tplSheet(k) {
  const t = TPL[k], groups = window._groups || [];
  const needGroup = k !== 'fee';
  sheet(`<h3>${t.title}</h3>
    ${needGroup ? `<label>Grup</label><select id="tg">${groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>` : '<p class="mu">Borcu olan tüm öğrencilerin velilerine kişiye özel hatırlatma gönderilir.</p>'}
    ${t.fields.includes('date') ? `<label>Tarih</label><input id="td" type="date" value="${today()}">` : ''}
    ${t.fields.includes('time') ? '<label>Yeni saat</label><input id="tt" type="time" value="18:00">' : ''}
    ${t.fields.includes('reason') ? '<label>Sebep (isteğe bağlı)</label><input id="tr" placeholder="Hava durumu">' : ''}
    ${t.fields.includes('msg') ? '<label>Mesaj</label><textarea id="tm" rows="4"></textarea>' : ''}
    <label>Kanal</label><div class="seg"><button class="chip on" data-ch="whatsapp">WhatsApp</button><button class="chip" data-ch="telegram">Telegram</button></div>
    <div id="prev"></div>
    <p></p><button class="btn" id="tprev">Önizle</button>`, (root) => {
    let ch = 'whatsapp';
    root.querySelectorAll('[data-ch]').forEach((b) => b.onclick = () => { ch = b.dataset.ch; root.querySelectorAll('[data-ch]').forEach((x) => x.classList.toggle('on', x === b)); });
    const body = () => {
      const g = (i) => root.querySelector('#' + i)?.value;
      const b = { channel: ch };
      if (needGroup) b.groupId = g('tg');
      if (g('td')) b.date = g('td'); if (g('tt')) b.newTime = g('tt'); if (g('tr')) b.reason = g('tr'); if (g('tm') != null) b.message = g('tm');
      if (k === 'fee') b.allDebtors = true;
      return b;
    };
    $('#tprev', root).onclick = guard(async () => {
      const r = (await post(t.path + '?dryRun=true', body())).data;
      if (!r.recipients) return toast('Alıcı bulunamadı');
      $('#prev', root).innerHTML = `<div class="hint"><b>${r.recipients} kişiye gönderilecek</b><br>${esc(r.sample)}</div>`;
      const btn = $('#tprev', root); btn.textContent = `Onayla ve ${r.recipients} kişiye gönder`;
      btn.onclick = guard(async () => {
        btn.disabled = true;
        const s = (await post(t.path, body())).data;
        closeSheet(); toast(`✔ ${s.queued} mesaj kuyruğa alındı`); render();
      });
    });
  });
}

// ---------- olay yönlendirme ----------
document.addEventListener('click', guard(async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, d = el.dataset;
  switch (act) {
    case 'logout': logout(); break;
    case 'goto': location.hash = '#/' + d.to; break;
    case 'attgroup': att = { groupId: d.id, date: att?.date || today() }; location.hash = '#/attendance/' + d.id; render(); break;
    case 'allpresent': att.students.forEach((s) => s.status = 'present'); drawAtt(); break;
    case 'cycle': {
      if (e.target.closest('[data-act="health"]')) return healthSheet(Number(d.i));
      const s = att.students[Number(d.i)]; s.status = ORDER[(ORDER.indexOf(s.status) + 1) % ORDER.length]; drawAtt(); break;
    }
    case 'health': healthSheet(Number(d.i)); break;
    case 'saveatt': {
      const r = await put(`/sessions/${att.sessionId}/attendance`, { records: att.students.map((s) => ({ studentId: s.studentId, status: s.status })) });
      toast(`✔ Kaydedildi: ${r.data.present} geldi, ${r.data.absent} gelmedi`); break;
    }
    case 'sgroup': sf.groupId = d.id; studentsView(); break;
    case 'sdebt': sf.hasDebt = !sf.hasDebt; studentsView(); break;
    case 'addstudent': studentSheet(); break;
    case 'delstudent': if (confirm('Öğrenci pasife alınsın mı?')) { await del('/students/' + d.id); toast('Pasife alındı'); location.hash = '#/students'; } break;
    case 'ftab': ftab = d.k; financeView(); break;
    case 'pay': paySheet(d.id ? { id: d.id, name: d.name } : null); break;
    case 'expense': expenseSheet(); break;
    case 'voidpay': if (confirm('Bu ödeme iptal edilsin mi?')) { await del('/finance/payments/' + d.id); toast('Ödeme iptal edildi'); loadFinance(); } break;
    case 'voidexp': if (confirm('Bu gider iptal edilsin mi?')) { await del('/finance/expenses/' + d.id); loadFinance(); } break;
    case 'gencharges': { const r = await post('/finance/charges/generate', { period: today().slice(0, 7) }); toast(`${r.data.created} yeni aidat oluşturuldu`); break; }
    case 'remindall': tplSheet('fee'); break;
    case 'tpl': tplSheet(d.k); break;
    case 'retry': await post(`/notifications/${d.id}/retry`); toast('Kuyruğa alındı'); notifyView(); break;
  }
}));

async function healthSheet(i) {
  const s = att.students[i];
  const r = (await api('/students/' + s.studentId)).data;
  sheet(`<h3>⚠ ${esc(r.firstName)} ${esc(r.lastName)}</h3>
    <div class="emerg"><p class="sm" style="margin:0"><b>Alerji:</b> ${esc(r.health.allergies || 'Yok')}<br><b>Kronik rahatsızlık:</b> ${esc(r.health.notes || 'Yok')}<br><b>Kan grubu:</b> ${esc(r.health.bloodType || '-')}</p></div>
    ${r.guardians.map((g) => `<div class="list-item"><div class="col"><span class="b">${esc(g.fullName)}</span><span class="mu sm">${esc(g.relation || '')} · ${esc(g.phone)}</span></div><a class="ibtn" href="tel:${esc(g.phone)}">📞</a></div>`).join('')}`);
}

render();
