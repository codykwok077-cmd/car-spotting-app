"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];
const XP = { Common: 10, Uncommon: 25, Rare: 60, Epic: 120, Legendary: 250, Mythic: 500 };
const RANKS = [
  { name: "Rookie", min: 0 },
  { name: "Bronze", min: 100 },
  { name: "Silver", min: 300 },
  { name: "Gold", min: 700 },
  { name: "Platinum", min: 1500 },
  { name: "Diamond", min: 3000 },
];
const REPEAT_XP = 5;
const KEY = "cardex.v1";
const PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

/* ---------- storage ---------- */
let db = load();

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.cards)) return { xp: 0, settings: { location: false }, ...d };
  } catch {}
  return { cards: [], xp: 0, settings: { location: false } };
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
    return true;
  } catch {
    toast("Storage is full. Export a backup, then delete some cards.");
    return false;
  }
}

/* ---------- helpers ---------- */
const money = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0, notation: n >= 1e6 ? "compact" : "standard" }).format(n);
const mid = (c) => ((c.value_usd?.low || 0) + (c.value_usd?.high || 0)) / 2;
const modelKey = (c) => `${c.make}|${c.model}|${c.generation}`.toLowerCase();
const rankFor = (xp) => [...RANKS].reverse().find((r) => xp >= r.min);
const photoOf = (c) => (PHOTO_RE.test(c.photo || "") ? c.photo : "");
const dash = (v, suffix = "") => (v == null ? "–" : v + suffix);

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

/* ---------- navigation ---------- */
function show(view) {
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $$(".tabs button").forEach((b) => {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (view === "garage") renderGarage();
  if (view === "profile") renderProfile();
  window.scrollTo(0, 0);
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

/* ---------- image handling ---------- */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => reject(new Error("Could not read that image. Try a JPEG or PNG."));
    img.src = url;
  });
}
function toJpeg(img, max, quality) {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}
function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: +p.coords.latitude.toFixed(4), lng: +p.coords.longitude.toFixed(4) }),
      () => resolve(null),
      { timeout: 4000, maximumAge: 60000 }
    );
  });
}

/* ---------- scanning ---------- */
const vf = $("#viewfinder");
const scanBtn = $("#scan-btn");
const fileInput = $("#file");

scanBtn.addEventListener("click", () => { fileInput.setAttribute("capture", "environment"); fileInput.click(); });
$("#pick-btn").addEventListener("click", () => { fileInput.removeAttribute("capture"); fileInput.click(); });
fileInput.addEventListener("change", () => {
  const f = fileInput.files[0];
  fileInput.value = "";
  if (f) scan(f);
});

function setBusy(on) {
  vf.classList.toggle("busy", on);
  scanBtn.disabled = on;
  scanBtn.textContent = on ? "Identifying…" : "Scan a car";
}
function setError(msg) {
  const el = $("#scan-error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

async function scan(file) {
  setError("");
  setBusy(true);
  try {
    const img = await loadImage(file);
    const big = toJpeg(img, 1280, 0.82);
    const thumb = toJpeg(img, 520, 0.7);
    vf.style.backgroundImage = `url("${thumb}")`;
    vf.classList.add("has-photo");

    const pos = db.settings.location ? await getPosition() : null;
    const res = await fetch("/api/identify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: big }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Scan failed. Try again.");
    if (!data.is_car) throw new Error("No car found in that photo. Frame the whole car and try again.");

    const isNew = !db.cards.some((c) => modelKey(c) === modelKey(data));
    const gained = isNew ? XP[data.rarity] : REPEAT_XP;
    const before = rankFor(db.xp).name;
    const card = { ...data, id: crypto.randomUUID(), photo: thumb, spottedAt: new Date().toISOString(), pos };

    db.cards.unshift(card);
    db.xp += gained;
    if (!save()) { db.cards.shift(); db.xp -= gained; return; }

    updateCount();
    const after = rankFor(db.xp).name;
    openDetail(card, { gained, isNew, rankUp: after !== before ? after : null });
  } catch (err) {
    setError(err.message || "Something went wrong. Try again.");
  } finally {
    setBusy(false);
  }
}

/* ---------- card rendering ---------- */
function cardHTML(c, interactive = true) {
  const rar = RARITIES.includes(c.rarity) ? c.rarity : "Common";
  const attrs = interactive ? 'tabindex="0" role="button"' : "";
  return `<article class="card r-${rar.toLowerCase()}" data-id="${esc(c.id)}" ${attrs} aria-label="${esc(c.make)} ${esc(c.model)}, ${rar}">
    <div class="face">
      <div class="photo" style="background-image:url('${photoOf(c)}')"></div>
      <div class="info">
        <p class="make">${esc(c.make)}</p>
        <h3>${esc(c.model)}</h3>
        <span class="plate">${esc(c.year || rar)}</span>
        <dl class="stats">
          <div><dt>hp</dt><dd>${esc(dash(c.power_hp))}</dd></div>
          <div><dt>0–100</dt><dd>${esc(dash(c.zero_to_100_s, "s"))}</dd></div>
          <div><dt>km/h</dt><dd>${esc(dash(c.top_speed_kmh))}</dd></div>
        </dl>
      </div>
    </div>
  </article>`;
}

/* ---------- garage ---------- */
let filter = "All";
$("#sort").addEventListener("change", renderGarage);

function renderGarage() {
  const present = RARITIES.filter((r) => db.cards.some((c) => c.rarity === r));
  if (filter !== "All" && !present.includes(filter)) filter = "All";
  $("#chips").innerHTML = ["All", ...present]
    .map((r) => `<button type="button" class="chip" aria-pressed="${r === filter}" data-r="${r}">${r}</button>`)
    .join("");
  $$(".chip").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.r; renderGarage(); }));

  const sort = $("#sort").value;
  const list = db.cards.filter((c) => filter === "All" || c.rarity === filter);
  if (sort === "value") list.sort((a, b) => mid(b) - mid(a));
  if (sort === "rarity") list.sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity));

  $("#grid").innerHTML = list.map(cardHTML).join("");
  $("#empty").hidden = db.cards.length > 0;
  $$("#grid .card").forEach((el) => {
    const open = () => openDetail(db.cards.find((c) => c.id === el.dataset.id));
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
}
function updateCount() { $("#count").textContent = db.cards.length; }

/* ---------- detail dialog ---------- */
const dlg = $("#detail");
function openDetail(c, fresh) {
  if (!c) return;
  const when = new Date(c.spottedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const where = c.pos
    ? `<dt>Spotted at</dt><dd><a href="https://www.openstreetmap.org/?mlat=${c.pos.lat}&mlon=${c.pos.lng}#map=15/${c.pos.lat}/${c.pos.lng}" target="_blank" rel="noopener" style="color:var(--plate)">${c.pos.lat}, ${c.pos.lng}</a></dd>`
    : "";
  const gain = fresh
    ? `<p class="gain">${fresh.isNew ? `New ${esc(c.rarity)} card` : "Repeat spot"}: +${fresh.gained} XP${fresh.rankUp ? ` · Rank up: ${esc(fresh.rankUp)}` : ""}</p>`
    : "";
  const low = c.value_usd?.low || 0, high = c.value_usd?.high || 0;

  dlg.innerHTML = `${gain}
    <div class="detail-card">${cardHTML(c, false)}</div>
    <dl class="facts">
      <dt>Rarity</dt><dd>${esc(c.rarity)}${c.rarity_reason ? ` – ${esc(c.rarity_reason)}` : ""}</dd>
      <dt>Generation</dt><dd>${esc(c.generation || "–")}</dd>
      <dt>Body</dt><dd>${esc(c.body || "–")}</dd>
      <dt>Engine</dt><dd>${esc(c.engine || "–")}</dd>
      <dt>Est. value</dt><dd>${high ? `${money(low)} – ${money(high)}` : "–"}</dd>
      <dt>Match</dt><dd>${Math.round((c.confidence ?? 0) * 100)}% confident</dd>
      <dt>Spotted</dt><dd>${esc(when)}</dd>${where}
    </dl>
    ${c.fun_fact ? `<p class="quote">${esc(c.fun_fact)}</p>` : ""}
    <p class="muted">Values are rough estimates, not appraisals.</p>
    <div class="row" style="margin-top:14px">
      <button type="button" class="primary" id="close-detail">Done</button>
      ${fresh ? "" : `<button type="button" class="secondary danger" id="del">Delete</button>`}
    </div>`;
  dlg.showModal();
  $("#close-detail").addEventListener("click", () => dlg.close());
  const del = $("#del");
  if (del) del.addEventListener("click", () => {
    if (!confirm("Delete this card? Your XP stays.")) return;
    db.cards = db.cards.filter((x) => x.id !== c.id);
    save(); updateCount(); renderGarage(); dlg.close();
  });
}
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
dlg.addEventListener("close", () => { if (!$("#view-garage").hidden) renderGarage(); });

/* ---------- profile ---------- */
function renderProfile() {
  const rank = rankFor(db.xp);
  const next = RANKS[RANKS.indexOf(rank) + 1];
  $("#rank-name").textContent = rank.name;
  $("#xp").textContent = `${db.xp} XP`;
  const pct = next ? ((db.xp - rank.min) / (next.min - rank.min)) * 100 : 100;
  $("#bar-fill").style.width = `${Math.min(100, pct)}%`;
  $("#rank-next").textContent = next ? `${next.min - db.xp} XP to ${next.name}` : "Top rank reached";

  const best = [...db.cards].sort((a, b) => mid(b) - mid(a))[0];
  const total = db.cards.reduce((s, c) => s + mid(c), 0);
  const stats = [
    ["Cards", db.cards.length],
    ["Unique models", new Set(db.cards.map(modelKey)).size],
    ["Garage value", db.cards.length ? money(total) : "–"],
    ["Top spot", best ? `${best.make} ${best.model}` : "–"],
  ];
  $("#stats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
  $("#loc").checked = !!db.settings.location;
}

$("#loc").addEventListener("change", (e) => {
  db.settings.location = e.target.checked;
  save();
  if (e.target.checked) getPosition(); // triggers the browser permission prompt now
});

$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(db)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cardex-garage-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#import-btn").addEventListener("click", () => $("#import").click());
$("#import").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.cards)) throw new Error();
    const have = new Set(db.cards.map((c) => c.id));
    const incoming = d.cards.filter(
      (c) => c && typeof c.id === "string" && !have.has(c.id) && RARITIES.includes(c.rarity) && PHOTO_RE.test(c.photo || "")
    );
    db.cards = [...incoming, ...db.cards].sort((a, b) => String(b.spottedAt).localeCompare(String(a.spottedAt)));
    db.xp = Math.max(db.xp, Number(d.xp) || 0);
    save(); updateCount(); renderProfile();
    toast(`Imported ${incoming.length} card${incoming.length === 1 ? "" : "s"}.`);
  } catch {
    toast("That file isn't a Cardex backup.");
  }
});

updateCount();
