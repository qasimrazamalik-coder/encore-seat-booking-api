// Encore frontend: plain JavaScript, no build step. The server decides who gets
// which seat; this page only shows the map, asks for holds and pays for them.

const $ = (id) => document.getElementById(id);
const $view = $('view');
const store = {
  get token() { try { return localStorage.getItem('enc.token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('enc.token', v) : localStorage.removeItem('enc.token'); } catch {} },
};
let me = null;
let countdown = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', maximumFractionDigits: 0 }).format(cents / 100);
const when = (d) => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && store.token) { store.token = null; me = null; }
  if (!res.ok) {
    const e = new Error(data.error?.message || 'Request failed');
    e.code = data.error?.code; e.details = data.error?.details; e.status = res.status;
    throw e;
  }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3600);
}

function drawNav(current) {
  const links = [['', "What's on"]];
  if (me) links.push(['tickets', 'My tickets']);
  if (me?.role === 'organizer') links.push(['door', 'Door and sales']);
  $('nav').innerHTML = links.map(([k, l]) => `<a href="#/${k}" ${k === current ? 'aria-current="page"' : ''}>${l}</a>`).join('')
    + (me ? `<span style="color:var(--muted)">${esc(me.name)}</span><button id="out">Sign out</button>` : '<a href="#/signin">Sign in</a>');
  $('out')?.addEventListener('click', () => { store.token = null; me = null; location.hash = '#/'; route(); });
}

function stopHoldbar() {
  clearInterval(countdown);
  countdown = null;
  $('holdbar').hidden = true;
}

// ---------- what's on ----------
async function viewListing() {
  drawNav('');
  const events = await api('/events');
  $view.innerHTML = `
    <h1>What's on</h1>
    <p class="lede">Pick a show, choose your seats, and they're yours for a few minutes while you pay.</p>
    <ul class="listing">${events.map((e) => {
      const d = new Date(e.startsAt);
      const low = e.seatsLeft > 0 && e.seatsLeft <= Math.max(5, e.seatsTotal * 0.15);
      return `<li>
        <div class="date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}</span></div>
        <div><h2><a href="#/event/${e.id}">${esc(e.title)}</a>${e.status === 'draft' ? '<span class="draft">Draft, only you can see it</span>' : ''}</h2>
          <p class="where">${esc(e.venue)}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</p></div>
        <div class="price">${e.fromCents != null ? `<strong>from ${money(e.fromCents)}</strong>` : ''}
          ${e.seatsLeft === 0 ? '<span class="low">Sold out</span>' : low ? `<span class="low">${e.seatsLeft} seats left</span>` : `${e.seatsLeft} seats left`}</div>
      </li>`;
    }).join('') || '<li style="display:block;color:var(--muted)">Nothing on sale right now. Check back soon.</li>'}</ul>`;
}

// ---------- the seat map ----------
let picked = new Set();
let current = null;

function seatMap(e) {
  const rows = [];
  for (const s of e.seats) {
    const last = rows[rows.length - 1];
    if (!last || last.row !== s.row) rows.push({ row: s.row, tier: s.tier, seats: [s] });
    else last.seats.push(s);
  }
  return `<div class="house">
    <div class="stage">STAGE</div>
    <div class="rows">${rows.map((r, ri) => {
      const n = r.seats.length;
      const mid = (n - 1) / 2;
      const gap = ri > 0 && rows[ri - 1].tier !== r.tier ? '<div class="tier-gap"></div>' : '';
      return `${gap}<div class="row"><span class="label">${esc(r.row)}</span>${r.seats.map((s, i) => {
        // Edges sit slightly closer to the stage, so each row curves round it.
        const lift = -Math.round(Math.pow((i - mid) / Math.max(mid, 1), 2) * 7);
        const state = picked.has(s.id) ? 'picked' : s.state === 'available' ? '' : s.state;
        const aisle = n >= 12 && i === Math.floor(n / 2) ? ' aisle' : '';
        const label = `Row ${s.row} seat ${s.number}, ${s.tier}, ${money(s.priceCents)}, ${state === 'taken' ? 'taken' : state === 'yours' ? 'held for you' : state === 'picked' ? 'selected' : 'available'}`;
        return `<button class="seat ${state}${aisle}" style="transform:translateY(${lift}px)" data-seat="${s.id}"
          aria-label="${label}" title="${s.row}${s.number} ${esc(s.tier)} ${money(s.priceCents)}" ${state === 'taken' ? 'disabled' : ''}></button>`;
      }).join('')}<span class="label">${esc(r.row)}</span></div>`;
    }).join('')}</div>
    <div class="key"><span><i></i>Free</span><span><i class="picked"></i>Your pick</span><span><i class="yours"></i>Held for you</span><span><i class="taken"></i>Taken</span></div>
  </div>`;
}

function summary(e) {
  const holding = e.myHold;
  const chosen = e.seats.filter((s) => picked.has(s.id) || (s.state === 'yours' && !picked.size));
  const total = chosen.reduce((n, s) => n + s.priceCents, 0);
  const sameAsHold = holding && picked.size === 0;
  return `<aside class="summary">
    <div class="tiers">${e.tiers.map((t) => `<div><span>${esc(t.name)}</span><span>${money(t.priceCents)}</span></div>`).join('')}</div>
    <h3>${sameAsHold ? 'Held for you' : 'Your seats'}</h3>
    ${chosen.length ? `<ul>${chosen.map((s) => `<li><span>${esc(s.row)}${s.number} <span class="hint">${esc(s.tier)}</span></span><span>${money(s.priceCents)}</span></li>`).join('')}</ul>
      <div class="total"><span>Total</span><span>${money(total)}</span></div>`
      : `<p class="hint">Tap seats on the map to choose them. Up to ${e.maxPerOrder} per person.</p>`}
    ${me ? '' : '<p class="hint"><a href="#/signin">Sign in</a> to hold seats.</p>'}
    ${me && picked.size ? `<button class="btn" id="holdBtn">${holding ? 'Hold these instead' : `Hold ${picked.size} seat${picked.size === 1 ? '' : 's'}`}</button>` : ''}
    ${sameAsHold ? `
      <form id="payF" style="display:grid;gap:10px">
        <label for="card" class="hint" style="margin:0">Card number</label>
        <input id="card" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" required>
        <button class="btn" id="payBtn">Pay ${money(total)}</button>
        <p class="hint">Test cards: 4242 4242 4242 4242 pays, 4000 0000 0000 0002 is declined.</p>
        <p class="err" id="payErr" hidden></p>
      </form>
      <button class="btn line" id="letGo">Let these seats go</button>` : ''}
  </aside>`;
}

async function viewEvent(id, { keepPicks = false } = {}) {
  drawNav('');
  const e = await api(`/events/${id}`);
  current = e;
  if (!keepPicks) picked = new Set();
  $view.innerHTML = `
    <div class="event-head">
      <div><h1>${esc(e.title)}</h1><p class="lede">${esc(e.description)}</p></div>
      <div><div class="when">${when(e.startsAt)}</div><div style="color:var(--muted)">${esc(e.venue)}</div></div>
    </div>
    ${e.status === 'cancelled' ? '<p class="err" style="margin-top:16px">This event has been cancelled. Everyone who booked has been refunded.</p>' : ''}
    <div class="booking"><div id="map">${seatMap(e)}</div><div id="side">${summary(e)}</div></div>`;
  wireEvent();
  if (e.myHold) startHoldbar(e.myHold.expiresAt); else stopHoldbar();
}

function redrawEvent() {
  $('map').innerHTML = seatMap(current);
  $('side').innerHTML = summary(current);
  wireEvent();
}

function wireEvent() {
  $('map').onclick = (ev) => {
    const b = ev.target.closest('[data-seat]');
    if (!b || b.disabled) return;
    const sid = Number(b.dataset.seat);
    if (picked.has(sid)) picked.delete(sid);
    else if (picked.size >= current.maxPerOrder) return toast(`You can choose up to ${current.maxPerOrder} seats.`, true);
    else picked.add(sid);
    redrawEvent();
    document.querySelector(`[data-seat="${sid}"]`)?.focus();
  };
  $('holdBtn')?.addEventListener('click', holdSeats);
  $('letGo')?.addEventListener('click', async () => {
    await api(`/holds/${current.myHold.id}`, { method: 'DELETE' });
    toast('Seats released.');
    viewEvent(current.id);
  });
  $('payF')?.addEventListener('submit', pay);
}

async function holdSeats() {
  const btn = $('holdBtn');
  btn.disabled = true;
  try {
    const h = await api('/holds', { method: 'POST', body: { eventId: current.id, seatIds: [...picked] } });
    toast(`Held ${h.seats.length} seat${h.seats.length === 1 ? '' : 's'}. You have ${Math.round(h.secondsLeft / 60)} minutes to pay.`);
    await viewEvent(current.id);
    $('card')?.focus();
  } catch (ex) {
    if (ex.code === 'SEATS_UNAVAILABLE') {
      for (const sid of ex.details.seatIds) picked.delete(sid);
      toast('Someone else just took some of those. They are greyed out now; pick again.', true);
      await viewEvent(current.id, { keepPicks: true });
    } else { toast(ex.message, true); btn.disabled = false; }
  }
}

// One key per pay attempt. A double click or a network retry reuses it, so the
// server replays the first answer instead of charging twice.
let payAttempt = null;
async function pay(ev) {
  ev.preventDefault();
  const btn = $('payBtn');
  if (payAttempt) return;
  btn.disabled = true;
  const key = uuid();
  payAttempt = key;
  try {
    const order = await api('/orders', { method: 'POST', headers: { 'Idempotency-Key': key },
      body: { holdId: current.myHold.id, cardNumber: $('card').value } });
    stopHoldbar();
    sessionStorage.setItem('enc.new', order.reference);
    location.hash = '#/tickets';
  } catch (ex) {
    const err = $('payErr');
    err.textContent = ex.message; err.hidden = false;
    btn.disabled = false;
    if (ex.code === 'HOLD_EXPIRED') { toast(ex.message, true); viewEvent(current.id); }
  } finally { payAttempt = null; }
}

function startHoldbar(expiresAt) {
  stopHoldbar();
  const bar = $('holdbar');
  const tick = () => {
    const left = Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 1000));
    const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
    bar.className = left <= 60 ? 'urgent' : '';
    bar.innerHTML = `<span class="time">${mm}:${ss}</span><span>Your seats are held. Pay before the timer runs out or they go back on sale.</span>
      <button class="btn" id="toPay">Pay now</button>`;
    $('toPay').onclick = () => $('card')?.focus();
    if (left === 0) {
      stopHoldbar();
      toast('Your hold ran out and the seats went back on sale.', true);
      if (current) viewEvent(current.id);
    }
  };
  bar.hidden = false;
  tick();
  countdown = setInterval(tick, 1000);
}

// ---------- my tickets ----------
async function viewTickets() {
  if (!me) return (location.hash = '#/signin');
  drawNav('tickets');
  stopHoldbar();
  const orders = await api('/orders');
  const fresh = sessionStorage.getItem('enc.new');
  sessionStorage.removeItem('enc.new');
  $view.innerHTML = `
    <h1>My tickets</h1>
    ${fresh ? `<p class="lede" style="color:var(--ink)">Paid. Your booking reference is <b>${esc(fresh)}</b>. Show the code on each ticket at the door.</p>` : ''}
    ${orders.map((o) => {
      const refundable = o.status === 'paid' && new Date(o.startsAt) - Date.now() > 24 * 3600000 && !o.tickets.some((t) => t.checkedInAt);
      return `<section>
        <div class="order-head"><h2>${esc(o.title)}</h2>
          <span><span class="ref">${esc(o.reference)}</span> ${o.status === 'refunded' ? '<span class="err">Refunded</span>' : ''}
          ${refundable ? `<button class="btn line" data-refund="${esc(o.reference)}" style="padding:5px 12px;margin-left:8px">Refund ${money(o.totalCents)}</button>` : ''}</span></div>
        <div class="stubs">${o.tickets.map((t) => `
          <article class="stub ${t.valid ? '' : 'void'}">
            <div class="main"><h3>${esc(o.title)}</h3>
              <div class="meta">${when(o.startsAt)}<br>${esc(o.venue)}<br>${esc(t.tier)}, ${money(t.priceCents)}${t.checkedInAt ? '<br>Used at the door' : ''}</div></div>
            <div class="tear"><span class="hint" style="font-size:.7rem;color:var(--muted)">SEAT</span><span class="seatno">${esc(t.seat)}</span><code>${esc(t.code)}</code></div>
          </article>`).join('')}</div>
      </section>`;
    }).join('') || '<p class="lede">No tickets yet. <a href="#/">See what\'s on</a>.</p>'}`;
  $view.onclick = async (ev) => {
    const ref = ev.target.dataset?.refund;
    if (!ref) return;
    ev.target.disabled = true;
    try { await api(`/orders/${ref}/refund`, { method: 'POST' }); toast('Refunded. The seats are back on sale.'); viewTickets(); }
    catch (ex) { toast(ex.message, true); ev.target.disabled = false; }
  };
}

// ---------- door and sales (organizer) ----------
async function viewDoor() {
  if (me?.role !== 'organizer') return (location.hash = '#/');
  drawNav('door');
  const events = await api('/events');
  const chosen = Number(sessionStorage.getItem('enc.doorEvent')) || events[0]?.id;
  $view.innerHTML = `
    <h1>Door and sales</h1>
    <p class="lede"><label for="ev">Event</label>
      <select id="ev" style="font:inherit;padding:6px;margin-left:8px">${events.map((e) => `<option value="${e.id}" ${e.id === chosen ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}</select></p>
    <div class="door">
      <div class="panel"><h2>Scan a ticket</h2>
        <form class="scan" id="scanF"><input id="code" placeholder="Ticket code" autocomplete="off" aria-label="Ticket code"><button class="btn">Admit</button></form>
        <div id="verdict"></div></div>
      <div class="panel" id="report"><h2>Sales</h2></div>
    </div>`;
  $('ev').onchange = () => { sessionStorage.setItem('enc.doorEvent', $('ev').value); viewDoor(); };
  $('scanF').onsubmit = async (ev) => {
    ev.preventDefault();
    const v = $('verdict');
    try {
      const r = await api(`/events/${$('ev').value}/check-in`, { method: 'POST', body: { code: $('code').value } });
      v.innerHTML = `<div class="verdict ok">Admit ${esc(r.holder)}, seat ${esc(r.seat)}.</div>`;
      loadReport();
    } catch (ex) {
      const extra = ex.code === 'ALREADY_CHECKED_IN' ? ` Seat ${esc(ex.details.seat)}, scanned ${new Date(ex.details.at).toLocaleTimeString('en-GB')}.` : '';
      v.innerHTML = `<div class="verdict no">Do not admit. ${esc(ex.message)}${extra}</div>`;
    }
    $('code').value = ''; $('code').focus();
  };
  if (chosen) loadReport();
}

async function loadReport() {
  const r = await api(`/events/${$('ev').value}/report`);
  $('report').innerHTML = `<h2>Sales</h2>
    <div class="figures"><div><strong>${money(r.revenueCents)}</strong>Taken</div><div><strong>${r.orders}</strong>Orders</div>
      <div><strong>${r.refunds}</strong>Refunds</div><div><strong>${r.checkedIn}</strong>Through the door</div></div>
    <table class="report"><thead><tr><th>Tier</th><th>Sold</th><th>Held</th><th>Seats</th></tr></thead>
      <tbody>${r.tiers.map((t) => `<tr><td>${esc(t.name)}<div class="bar"><span style="width:${t.sellThrough || 0}%"></span></div></td>
        <td>${t.sold}</td><td>${t.held}</td><td>${t.seats}</td></tr>`).join('')}</tbody></table>`;
}

// ---------- sign in ----------
function viewSignin() {
  drawNav('signin');
  $view.innerHTML = `
    <form class="signin" id="f">
      <h1>Sign in</h1>
      <div><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>
      <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
      <button class="btn">Sign in</button>
      <p class="err" id="err" hidden></p>
      <p class="demo">Demo: <button type="button" data-u="zainab">Zainab (customer)</button> or
        <button type="button" data-u="organizer">the organizer</button>. Password is password123.</p>
    </form>`;
  document.querySelectorAll('[data-u]').forEach((b) => (b.onclick = () => {
    $('email').value = `${b.dataset.u}@encore.test`; $('pw').value = 'password123';
  }));
  $('f').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: $('email').value, password: $('pw').value } });
      store.token = r.token; me = r.user;
      location.hash = me.role === 'organizer' ? '#/door' : '#/';
    } catch (ex) { $('err').textContent = ex.message; $('err').hidden = false; }
  };
}

// ---------- router ----------
async function route() {
  if (store.token && !me) { try { me = await api('/auth/me'); } catch { me = null; } }
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  $view.onclick = null;
  if (page !== 'event') stopHoldbar();
  try {
    if (page === 'event') await viewEvent(Number(arg));
    else if (page === 'tickets') await viewTickets();
    else if (page === 'door') await viewDoor();
    else if (page === 'signin') viewSignin();
    else await viewListing();
  } catch (ex) {
    $view.innerHTML = `<h1>That didn't load</h1><p class="lede">${esc(ex.message)} Go back to <a href="#/">what's on</a>.</p>`;
  }
  $view.focus();
}
window.addEventListener('hashchange', route);
route();
