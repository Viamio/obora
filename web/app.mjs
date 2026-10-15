import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc, getDoc, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import * as L from "./logic.mjs";

export const APP_VERSION = "1.7";
const $ = (id) => document.getElementById(id);
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
$("ver").textContent = `Wersja ${APP_VERSION}`;
function status(t) { $("status").textContent = t; }

// ---------------- instalacja i aktualizacje ----------------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
if (isIOS && !standalone) $("iosBar").hidden = false;

let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("installBar").hidden = false; });
$("installBtn").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("installBar").hidden = true; };
window.addEventListener("appinstalled", () => { $("installBar").hidden = true; });

let swReg = null;
let refreshing = false;
function showUpdate(worker) {
  $("updBar").hidden = false;
  $("updBtn").onclick = () => { $("updBtn").disabled = true; $("updBtn").textContent = "Instaluję…"; worker.postMessage("AKTUALIZUJ"); };
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!refreshing) { refreshing = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js").then((reg) => {
    swReg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(w); });
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
}
async function checkUpdate() {
  if (!swReg) { status("Aktualizacje działają po zainstalowaniu aplikacji."); return; }
  status("Sprawdzam…");
  try { await swReg.update(); } catch {}
  setTimeout(() => { status($("updBar").hidden ? `Masz najnowszą wersję (${APP_VERSION}).` : "Jest nowa wersja – naciśnij Aktualizuj na górze."); }, 2500);
}

// ---------------- Firebase ----------------
const cfgFb = self.OBORA_FIREBASE || {};
if (!cfgFb.apiKey) { $("cfgErr").hidden = false; throw new Error("Brak konfiguracji Firebase"); }
const fbApp = initializeApp(cfgFb);
let db;
try { db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch { db = initializeFirestore(fbApp, {}); }

const farmDoc = (f) => doc(db, "gospodarstwa", f);
const cowsCol = (f) => collection(db, "gospodarstwa", f, "krowy");
const calvesCol = (f) => collection(db, "gospodarstwa", f, "mlodziez");
const cfgDocRef = (f) => doc(db, "gospodarstwa", f, "ustawienia", "glowne");

function newCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint32Array(12));
  const s = [...r].map((x) => abc[x % abc.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const cleanCode = (s) => s.trim().toUpperCase().replace(/\s+/g, "");
const validCode = (s) => /^[A-Z0-9-]{12,40}$/.test(s);
/** Odmiana: odm(1,"krowa","krowy","krów") */
function odm(n, one, few, many) { const m10 = n % 10, m100 = n % 100; return n === 1 ? one : (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) ? few : many; }
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------------- stan ----------------
let farm = LS.get("obora_farm");
let cows = [], calves = [];
let cfg = L.cfgOf();
let cfgLoaded = false;
let editId = null, confirmId = null, calfEditId = null;
let unsub = [];
let loaded = false;
let query = "";
const NO_PLACE = "__brak";
const placeOf = (a) => (a.miejsce || "").trim();
let tab = LS.get("obora_tab") || "glowna";   // glowna | m:<miejsce> | m:__brak | cielaki | jalowki | ustawienia
let calfMode = "cielak";
/** Typ młodego zwierzęcia: "cielak" albo "jalowka" (stare wpisy bez typu: byczek = cielak, jałówka od 6 mies. = jałówka). */
function typOf(c) {
  if (c.typ === "cielak" || c.typ === "jalowka") return c.typ;
  if (c.plec === "b") return "cielak";
  return (L.monthsOld(c.urodzona) ?? 0) >= 6 ? "jalowka" : "cielak";
}
const kindLabel = (c) => (typOf(c) === "jalowka" ? "Jałówka" : c.plec === "b" ? "Cielak · byk" : "Cielak · jałoszka");

/** Lista miejsc: z ustawień, a jeśli pusta – z tego, co już wpisano przy krowach. */
function places() {
  const list = Array.isArray(cfg.miejsca) ? cfg.miejsca.filter(Boolean) : [];
  const extra = [...new Set([...cows, ...calves].map(placeOf).filter((p) => p && !list.includes(p)))];
  return [...list, ...extra.sort((a, b) => a.localeCompare(b, "pl"))];
}
const inPlace = (key) => (a) => (key === NO_PLACE ? !placeOf(a) : placeOf(a) === key);

// ---------------- ekran startowy ----------------
$("createFarm").onclick = async () => {
  const code = newCode();
  $("createFarm").disabled = true;
  try { await setDoc(farmDoc(code), { utworzono: Date.now() }); }
  catch { $("createFarm").disabled = false; $("joinErr").textContent = "Nie udało się założyć gospodarstwa. Sprawdź internet."; $("joinErr").hidden = false; return; }
  $("newCode").textContent = code; $("newCodeBox").hidden = false; $("createFarm").hidden = true;
  $("newCodeOk").onclick = () => start(code);
};
$("joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = cleanCode($("joinCode").value);
  const err = (t) => { $("joinErr").textContent = t; $("joinErr").hidden = false; };
  if (!validCode(code)) return err("Kod ma co najmniej 12 znaków, np. ABCD-EFGH-JKLM.");
  $("joinBtn").disabled = true; $("joinBtn").textContent = "Sprawdzam…";
  try { const s = await getDoc(farmDoc(code)); if (s.exists()) start(code); else err("Nie ma gospodarstwa z takim kodem. Sprawdź litery."); }
  catch { err("Brak połączenia z internetem. Spróbuj ponownie."); }
  $("joinBtn").disabled = false; $("joinBtn").textContent = "Połącz z gospodarstwem";
});

function start(code) {
  farm = code; LS.set("obora_farm", code);
  $("setup").hidden = true; $("app").hidden = false; $("fab").hidden = false;
  unsub.forEach((u) => u()); unsub = [];
  unsub.push(onSnapshot(cowsCol(code), (snap) => {
    cows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loaded = true;
    const off = "Bez internetu – zmiany wyślą się później.";
    if (snap.metadata.fromCache) status(off); else if ($("status").textContent === off) status("");
    render();
  }, () => status("Brak dostępu do bazy. Sprawdź internet.")));
  unsub.push(onSnapshot(calvesCol(code), (snap) => {
    calves = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, () => {}));
  unsub.push(onSnapshot(cfgDocRef(code), (s) => {
    cfg = L.cfgOf(s.data()); cfgLoaded = true;
    const active = document.activeElement?.id || "";
    if (tab === "ustawienia" && active.startsWith("set")) return; // nie przerywaj wpisywania
    updatePreview(); render();
  }, () => {}));
  render();
  refreshNotifBar();
  if (pushPossible() && Notification.permission === "granted") registerPush(false);
}

// ---------------- powiadomienia ----------------
function pushPossible() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
function refreshNotifBar() {
  const bar = $("notifBar"), p = bar.querySelector("p");
  if (!pushPossible()) {
    if (isIOS && !standalone) {
      p.innerHTML = "<b>Powiadomienia na iPhonie</b> działają po dodaniu aplikacji do ekranu początkowego (instrukcja wyżej) i otwarciu jej z ikony.";
      $("notifBtn").hidden = true; bar.hidden = false;
    } else bar.hidden = true;
    return;
  }
  bar.hidden = Notification.permission === "granted";
  if (Notification.permission === "denied") {
    p.innerHTML = "<b>Powiadomienia są zablokowane.</b> Włącz je w ustawieniach telefonu dla tej aplikacji.";
    $("notifBtn").hidden = true;
  }
}
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
async function registerPush(interactive) {
  try {
    if (!pushPossible() || !(await isSupported())) { if (interactive) status("Ten telefon lub przeglądarka nie obsługuje powiadomień."); return false; }
    if (!self.OBORA_VAPID) { if (interactive) status("Powiadomienia nie są jeszcze skonfigurowane."); return false; }
    const reg = swReg || (await navigator.serviceWorker.ready);
    const token = await getToken(getMessaging(fbApp), { vapidKey: self.OBORA_VAPID, serviceWorkerRegistration: reg });
    if (!token || !farm) return false;
    await setDoc(doc(db, "gospodarstwa", farm, "telefony", await sha(token)), { token, zmieniono: Date.now(), ios: isIOS });
    if (interactive) status("Powiadomienia włączone. Codziennie rano dostaniesz listę zadań.");
    return true;
  } catch {
    if (interactive) status("Nie udało się włączyć powiadomień. Spróbuj ponownie.");
    return false;
  }
}
$("notifBtn").onclick = async () => {
  const p = await Notification.requestPermission();
  refreshNotifBar();
  if (p === "granted") await registerPush(true);
};
async function testNotif() {
  if (!pushPossible() || Notification.permission !== "granted") { status("Najpierw włącz powiadomienia (przycisk „Włącz” na górze)."); $("notifBar").hidden = false; return; }
  const list = allAlerts(cows, calves, 1, 7);
  const reg = swReg || (await navigator.serviceWorker.ready);
  await reg.showNotification(list.length ? `Obora: ${list.length} ${L.zadania(list.length)}` : "Obora: nic do zrobienia", {
    body: list.slice(0, 6).map((a) => `${a.cow.kolczyk}: ${a.title} ${L.kiedy(a.n)}`).join("\n") || "Na dziś brak zadań.",
    icon: "ikona-192.png", badge: "odznaka-96.png", tag: "obora-test",
  });
  status("Wysłano – sprawdź pasek powiadomień.");
}
const allAlerts = (cs, ks, ahead, dueAhead) =>
  [...L.alerts(cs, cfg, ahead, dueAhead), ...L.calfAlerts(ks, cfg, ahead)].sort((a, b) => a.n - b.n);

// ---------------- zapis ----------------
const rowData = (c) => { const { id, ...r } = c; return r; };
function writeCow(id, data) {
  data.termin = L.due(data) || "";
  data.zmieniono = Date.now();
  setDoc(doc(cowsCol(farm), id), data).catch(() => status("Nie udało się zapisać. Sprawdź internet."));
}
function patch(c, changes, msg) { writeCow(c.id, { ...rowData(c), ...changes }); if (msg) status(msg); }
function writeCalf(id, data) {
  data.zmieniono = Date.now();
  setDoc(doc(calvesCol(farm), id), data).catch(() => status("Nie udało się zapisać. Sprawdź internet."));
}
function saveCfg(next, msg) {
  cfg = next;
  return setDoc(cfgDocRef(farm), cfg).then(() => { if (msg) status(msg); }).catch(() => status("Nie udało się zapisać ustawień."));
}

// ---------------- elementy ----------------
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function btn(text, cls, fn) { const b = el("button", cls, text); b.type = "button"; b.onclick = fn; return b; }
function placeSelect(sel, value) {
  sel.replaceChildren();
  const o0 = el("option", null, "— bez miejsca —"); o0.value = ""; sel.append(o0);
  for (const p of places()) { const o = el("option", null, p); o.value = p; sel.append(o); }
  sel.value = value || "";
}

// ---------------- zakładki ----------------
function tabList() {
  const t = [{ key: "glowna", label: "Główna" }];
  for (const p of places()) t.push({ key: "m:" + p, label: p, n: cows.filter(inPlace(p)).length + calves.filter(inPlace(p)).length });
  const none = cows.filter(inPlace(NO_PLACE)).length + calves.filter(inPlace(NO_PLACE)).length;
  if (none && places().length) t.push({ key: "m:" + NO_PLACE, label: "Bez miejsca", n: none });
  t.push({ key: "cielaki", label: "Cielaki", n: calves.filter((c) => typOf(c) === "cielak").length });
  t.push({ key: "jalowki", label: "Jałówki", n: calves.filter((c) => typOf(c) === "jalowka").length });
  t.push({ key: "ustawienia", label: "Ustawienia" });
  return t;
}
function setTab(key, dir = 0) {
  if (key === tab) return;
  tab = key; LS.set("obora_tab", key);
  if (!editId) closeDialogs();
  render(dir);
  window.scrollTo({ top: 0 });
}
function renderTabs(list) {
  const nav = $("tabs"); nav.replaceChildren();
  for (const t of list) {
    const b = el("button", "tab" + (t.key === tab ? " on" : ""));
    b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", t.key === tab);
    b.append(document.createTextNode(t.label));
    if (t.n != null) b.append(el("b", null, String(t.n)));
    b.onclick = () => { const i = list.findIndex((x) => x.key === tab), j = list.findIndex((x) => x.key === t.key); setTab(t.key, Math.sign(j - i)); };
    nav.append(b);
    if (t.key === tab) requestAnimationFrame(() => b.scrollIntoView({ inline: "center", block: "nearest" }));
  }
  $("swipeHint").hidden = list.length < 4 || LS.get("obora_swiped") === "1";
}

// przesuwanie palcem między zakładkami
(() => {
  const area = $("view");
  let x0 = null, y0 = 0, t0 = 0;
  area.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || e.target.closest("input,select,textarea,.noswipe")) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  area.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6 || Date.now() - t0 > 800) return;
    const list = tabList(), i = list.findIndex((t) => t.key === tab);
    const j = dx < 0 ? i + 1 : i - 1;
    if (j >= 0 && j < list.length) { LS.set("obora_swiped", "1"); setTab(list[j].key, dx < 0 ? 1 : -1); }
  }, { passive: true });
})();

// ---------------- widoki ----------------
function render(dir = 0) {
  if (!farm) return;
  const list = tabList();
  if (!list.some((t) => t.key === tab)) tab = "glowna";
  renderTabs(list);
  fillLists();
  const v = $("view");
  v.replaceChildren();
  if (tab === "glowna") viewMain(v);
  else if (tab === "cielaki" || tab === "jalowki") viewCalves(v, tab === "cielaki" ? "cielak" : "jalowka");
  else if (tab === "ustawienia") viewSettings(v);
  else viewPlace(v, tab.slice(2));
  $("fab").textContent = tab === "cielaki" ? "+ Dodaj cielaka" : tab === "jalowki" ? "+ Dodaj jałówkę" : "+ Dodaj";
  $("fab").hidden = tab === "ustawienia";
  if (dir) { v.classList.remove("in-l", "in-r"); void v.offsetWidth; v.classList.add(dir > 0 ? "in-r" : "in-l"); }
}

function statsRow(cs) {
  const today = L.todayISO();
  const row = el("div", "stats");
  const st = (n, label) => { const d = el("div", "stat"); d.append(el("b", null, String(n)), el("span", null, label)); return d; };
  row.append(
    st(cs.length, "Krów"),
    st(cs.filter((c) => L.pregnant(c)).length, "Zacielonych"),
    st(cs.filter((c) => { const d = L.due(c); if (!d) return false; const n = L.daysBetween(today, d); return n >= 0 && n <= 30; }).length, "Poród ≤ 30 dni"),
  );
  return row;
}

function viewMain(v) {
  // liczby sztuk: wszystkie i w miejscach
  const all = cows.length + calves.length;
  const sum = el("section", "card summary");
  const h = el("div", "sumtop");
  h.append(el("span", "big", String(all)), el("span", null, `${odm(all, "sztuka", "sztuki", "sztuk")} w gospodarstwie`));
  sum.append(h);
  const jal = calves.filter((c) => typOf(c) === "jalowka").length;
  const cb = calves.filter((c) => typOf(c) === "cielak" && c.plec === "b").length, cj = calves.filter((c) => typOf(c) === "cielak" && c.plec !== "b").length;
  const sub = el("p", "hint", `${cows.length} ${odm(cows.length, "krowa", "krowy", "krów")} · ${jal} ${odm(jal, "jałówka", "jałówki", "jałówek")} · ${cb + cj} ${odm(cb + cj, "cielak", "cielaki", "cielaków")} (${cb} ${odm(cb, "byk", "byki", "byków")}, ${cj} ${odm(cj, "jałoszka", "jałoszki", "jałoszek")})`);
  sum.append(sub);
  const grid = el("div", "placegrid");
  const ps = places();
  for (const p of ps) grid.append(placeTile(p, p));
  const none = cows.filter(inPlace(NO_PLACE)).length + calves.filter(inPlace(NO_PLACE)).length;
  if (none && ps.length) grid.append(placeTile("Bez miejsca", NO_PLACE));
  if (!ps.length) {
    const e = el("div", "empty", "Nie masz jeszcze miejsc. Dodaj je w zakładce Ustawienia, np. „Średnia obora”, „Porodówka”, „Jałowizna”.");
    e.append(el("br"), btn("Dodaj miejsca", "ghost", () => setTab("ustawienia", 1)));
    grid.append(e);
  }
  sum.append(grid);
  v.append(sum);
  v.append(statsRow(cows));
  alertsSection(v, cows, calves);
  // pełna lista całego stada z wyszukiwarką
  const s = el("input"); s.type = "search"; s.id = "szukaj"; s.placeholder = "Szukaj kolczyka, byka, matki…"; s.value = query;
  s.oninput = () => { query = s.value; renderSearch(); };
  const res = el("div", "col"); res.id = "searchRes";
  const sec = el("section", "col"); sec.append(el("h2", null, `Wszystkie zwierzęta (${all})`), s, res); v.append(sec);
  renderSearch();
}
function placeTile(label, key) {
  const nc = cows.filter(inPlace(key)).length, nk = calves.filter(inPlace(key)).length;
  const b = el("button", "ptile"); b.type = "button";
  b.append(el("span", "pname", label), el("b", null, String(nc + nk)));
  b.append(el("small", null, [nc ? `${nc} ${odm(nc, "krowa", "krowy", "krów")}` : "", nk ? `${nk} ${odm(nk, "młode", "młode", "młodych")}` : ""].filter(Boolean).join(" · ") || "pusto"));
  b.onclick = () => setTab("m:" + key, 1);
  return b;
}
function renderSearch() {
  const box = $("searchRes"); if (!box) return;
  box.replaceChildren();
  const q = query.trim().toUpperCase();
  const hit = (a) => !q || [a.kolczyk, a.ojciec, a.byk, a.matka, a.miejsce].some((x) => (x || "").toUpperCase().includes(q));
  const cs = sortCows(cows.filter(hit)), ks = sortCalves(calves.filter(hit));
  if (!loaded) { box.append(el("div", "empty", "Ładowanie stada…")); return; }
  if (!cs.length && !ks.length) { box.append(el("div", "empty", q ? "Nic nie znaleziono." : "Brak zwierząt. Dodaj pierwszą krowę przyciskiem na dole.")); return; }
  if (cs.length) {
    box.append(el("h3", "subh", `Krowy (${cs.length})`));
    const l = el("div", "list"); cs.forEach((c) => l.append(cowCard(c))); box.append(l);
  }
  if (ks.length) {
    box.append(el("h3", "subh", `Jałówki i cielaki (${ks.length})`));
    const l = el("div", "list"); ks.forEach((c) => l.append(calfCard(c))); box.append(l);
  }
}

function viewPlace(v, key) {
  const label = key === NO_PLACE ? "Bez miejsca" : key;
  const cs = cows.filter(inPlace(key)), ks = calves.filter(inPlace(key));
  const head = el("div", "placehead");
  head.append(el("h2", null, label), el("span", "count", `${cs.length + ks.length} szt.`));
  v.append(head, statsRow(cs));
  alertsSection(v, cs, ks);
  const sec = el("section", "col");
  sec.append(el("h2", null, `Krowy (${cs.length})`));
  const list = el("div", "list");
  if (!loaded) list.append(el("div", "empty", "Ładowanie stada…"));
  else if (!cs.length) list.append(el("div", "empty", "W tym miejscu nie ma krów. Dodaj krowę przyciskiem na dole albo przenieś ją tu z innego miejsca."));
  sortCows(cs).forEach((c) => list.append(cowCard(c)));
  sec.append(list);
  v.append(sec);
  if (ks.length) {
    const s2 = el("section", "col"); s2.append(el("h2", null, `Jałówki i cielaki (${ks.length})`));
    const l2 = el("div", "list"); sortCalves(ks).forEach((c) => l2.append(calfCard(c))); s2.append(l2); v.append(s2);
  }
}

function viewCalves(v, typ) {
  const ks = calves.filter((c) => typOf(c) === typ);
  const head = el("div", "placehead");
  head.append(el("h2", null, typ === "cielak" ? "Cielaki" : "Jałówki"), el("span", "count", `${ks.length} szt.`));
  v.append(head);
  if (typ === "cielak") {
    const nb = ks.filter((c) => c.plec === "b").length;
    v.append(el("p", "hint", `${nb} ${odm(nb, "byk", "byki", "byków")} · ${ks.length - nb} ${odm(ks.length - nb, "jałoszka", "jałoszki", "jałoszek")}. Gdy jałoszka podrośnie, stuknij przy niej „Do jałówek”.`));
  } else {
    v.append(el("p", "hint", `Jałówki są gotowe do krycia po ${cfg.krycie} miesiącach (zmienisz w Ustawieniach). Rano dostaniesz o tym powiadomienie.`));
  }
  alertsSection(v, [], ks, typ === "cielak" ? "Do zrobienia" : "Do krycia");
  const list = el("div", "list");
  if (!ks.length) list.append(el("div", "empty", typ === "cielak"
    ? "Brak cielaków. Dodaj pierwszego przyciskiem „+ Dodaj cielaka” na dole: kolczyk, byk albo jałoszka, data urodzenia albo wiek."
    : "Brak jałówek. Dodaj przyciskiem „+ Dodaj jałówkę” na dole albo przenieś podrośniętą jałoszkę z zakładki Cielaki."));
  sortCalves(ks).forEach((c) => list.append(calfCard(c)));
  v.append(list);
}

function alertsSection(v, cs, ks, title = "Do zrobienia") {
  const sec = el("section", "col");
  sec.append(el("h2", null, title));
  const box = el("div", "alerts");
  const today = L.todayISO();
  const list = allAlerts(cs, ks, cfg.ahead, 14);
  if (!list.length) box.append(el("div", "empty", cs.length + ks.length ? `Nic do zrobienia w najbliższych ${L.dni(cfg.ahead)}.` : "Tu pojawią się zadania: zacielenie, ruja, badanie cielności, zasuszenie, porodówka, wycielenie i krycie jałówek."));
  for (const a of list) {
    const c = a.cow;
    const cls = a.kind === "due" || (a.n <= 0 && a.kind === "check") ? "soon" : a.n <= 0 ? "warn" : "";
    const row = el("div", "alert " + cls);
    const t = el("div", "atxt");
    t.append(el("b", null, `${a.title} ${L.kiedy(a.n)}`), el("small", null, a.sub + (placeOf(c) && !tab.startsWith("m:") ? ` · ${placeOf(c)}` : "")));
    const ab = el("div", "abtns");
    row.append(el("span", "tag", c.kolczyk), t, ab);
    const zacielona = () => { openCow(c, { zacielenie: today, ruja: today }); status("Wpisz, jakim bykiem zacielona, i naciśnij Zapisz."); setTimeout(() => $("byk").focus(), 50); };
    if (a.kind === "check") ab.append(btn("Cielna", "okbtn", () => patch(c, { cielna: "tak" }, `${c.kolczyk}: cielna`)), btn("Niecielna", "nobtn", () => patch(c, { cielna: "nie" }, `${c.kolczyk}: niecielna`)));
    if (a.kind === "dry") ab.append(btn("Zasuszona", "okbtn", () => patch(c, { zasuszona: true }, `${c.kolczyk}: zasuszona`)));
    if (a.kind === "move") ab.append(btn("Przegnana", "okbtn", () => patch(c, { przegnana: true }, `${c.kolczyk}: na porodówce`)));
    if (a.kind === "ruja") ab.append(btn("Grzeje się dziś", "nobtn", () => patch(c, { ruja: today }, `${c.kolczyk}: ruja zapisana`)), btn("Zacielona dziś", "okbtn", zacielona));
    if (a.kind === "insem") ab.append(btn("Zacielona dziś", "okbtn", zacielona));
    if (a.kind === "due") ab.append(btn("Wycieliła się", "okbtn", () => patch(c, { wycielenie: today, zacielenie: "", byk: "", ruja: "", cielna: "", zasuszona: false, przegnana: false }, `${c.kolczyk}: wycielenie zapisane`)));
    if (a.kind === "krycie") ab.append(btn("Zacielona dziś", "okbtn", () => toHerd(c, { zacielenie: today, ruja: today })), btn("Do stada krów", "nobtn", () => toHerd(c, {})));
    box.append(row);
  }
  sec.append(box);
  v.append(sec);
}

function sortCows(cs) {
  return [...cs].sort((a, b) => {
    const da = L.due(a), db_ = L.due(b);
    if (da && db_) return da < db_ ? -1 : 1;
    if (da) return -1; if (db_) return 1;
    return (a.kolczyk || "").localeCompare(b.kolczyk || "");
  });
}
const sortCalves = (ks) => [...ks].sort((a, b) => (a.urodzona || "9999") < (b.urodzona || "9999") ? -1 : 1);

/** Szybkie przeniesienie do innego miejsca – lista rozwijana na karcie. */
function moveSelect(a, onMove) {
  const sel = el("select", "locsel noswipe");
  sel.setAttribute("aria-label", "Przenieś do miejsca");
  placeSelect(sel, placeOf(a));
  sel.onchange = () => onMove(sel.value);
  const wrap = el("label", "locwrap"); wrap.append(el("span", null, "Miejsce"), sel);
  return wrap;
}

function cowCard(c) {
  const today = L.todayISO();
  const due = L.due(c);
  const card = el("article", "cow");
  const top = el("div", "cowtop");
  const left = el("div", "cowleft");
  left.append(el("span", "tag", c.kolczyk));
  if (c.zacielenie && (L.pregnant(c) || c.cielna === "nie")) {
    const chip = el("span", "chip", c.cielna === "tak" ? "Cielna ✓" : c.cielna === "nie" ? "Niecielna" : "Do sprawdzenia");
    if (c.cielna === "tak") chip.classList.add("yes"); if (c.cielna === "nie") chip.classList.add("no");
    left.append(chip);
  }
  const pill = el("span", "pill");
  if (!due) { pill.classList.add("none"); pill.textContent = c.cielna === "nie" ? "Do ponownego krycia" : "Niezacielona"; }
  else {
    const n = L.daysBetween(today, due);
    if (n < 0) { pill.classList.add("warn"); pill.textContent = `Po terminie ${L.dni(n)}`; }
    else if (n === 0) { pill.classList.add("soon"); pill.textContent = "Poród dziś"; }
    else { if (n <= 30) pill.classList.add("soon"); pill.textContent = `Poród za ${L.dni(n)}`; }
  }
  top.append(left, pill);
  const dl = el("dl");
  const items = [
    ["Po byku", c.ojciec || "—"],
    ["Zacielona bykiem", c.byk || "—"],
    [c.wytrucie && c.wytrucie === c.wycielenie ? "Wytrucie" : "Ost. wycielenie", L.fmt(c.wycielenie)],
    ["Ostatnia ruja", L.fmt(c.ruja)],
    ["Następna ruja", L.fmt(L.nextRuja(c, today))],
    ["Zacielenie", L.fmt(c.zacielenie)],
    ["Sprawdzić cielność", L.fmt(L.checkDate(c, cfg))],
    ["Zasuszenie", c.zasuszona ? "zrobione" : L.fmt(L.dryDate(c, cfg))],
    ["Na porodówkę", c.przegnana ? "zrobione" : L.fmt(L.moveDate(c, cfg))],
    ["Termin porodu", L.fmt(due)],
  ];
  for (const [k, val] of items) { const w = el("div"); w.append(el("dt", null, k), el("dd", k === "Termin porodu" && due ? "big" : null, val)); dl.append(w); }
  card.append(top, dl);
  const foot = el("div", "cowfoot");
  foot.append(moveSelect(c, (p) => patch(c, { miejsce: p }, `${c.kolczyk} → ${p || "bez miejsca"}`)));
  const btns = el("div", "cowbtns");
  if (confirmId === c.id) {
    const q2 = el("span", "note", "Usunąć tę krowę?");
    btns.append(q2, btn("Nie", "ghost", () => { confirmId = null; render(); }), btn("Tak, usuń", "del", () => removeCow(c.id)));
  } else {
    if (c.zacielenie && c.cielna) btns.append(btn("Cofnij badanie", "ghost", () => patch(c, { cielna: "" }, `${c.kolczyk}: wynik cofnięty`)));
    btns.append(btn("Edytuj", "ghost", () => openCow(c)), btn("Usuń", "ghost", () => { confirmId = c.id; render(); }));
  }
  foot.append(btns);
  card.append(foot);
  return card;
}

function calfCard(c) {
  const today = L.todayISO();
  const card = el("article", "cow calf");
  const top = el("div", "cowtop");
  const left = el("div", "cowleft");
  left.append(el("span", "tag", c.kolczyk), el("span", "chip " + (c.plec === "b" ? "" : "yes"), kindLabel(c)));
  const age = el("span", "pill", L.ageText(c.urodzona, today));
  top.append(left, age);
  const dl = el("dl");
  const bd = L.breedDate(c, cfg);
  let breedTxt = "—";
  if (bd) { const n = L.daysBetween(today, bd); breedTxt = n <= 0 ? "teraz" : `${L.fmt(bd)} (${L.kiedy(n)})`; }
  const items = [
    ["Urodzona", L.fmt(c.urodzona)],
    ["Wiek", L.ageText(c.urodzona, today)],
    ["Matka", c.matka || "—"],
    ["Po byku", c.ojciec || "—"],
  ];
  if (c.plec !== "b") items.push(["Do krycia", breedTxt], ["Miesięcy", c.urodzona ? String(L.monthsOld(c.urodzona, today)) : "—"]);
  for (const [k, val] of items) { const w = el("div"); w.append(el("dt", null, k), el("dd", k === "Do krycia" && bd && L.daysBetween(today, bd) <= 0 ? "big" : null, val)); dl.append(w); }
  card.append(top, dl);
  const foot = el("div", "cowfoot");
  foot.append(moveSelect(c, (p) => { writeCalf(c.id, { ...rowData(c), miejsce: p }); status(`${c.kolczyk} → ${p || "bez miejsca"}`); }));
  const btns = el("div", "cowbtns");
  if (confirmId === c.id) {
    btns.append(el("span", "note", "Usunąć?"), btn("Nie", "ghost", () => { confirmId = null; render(); }), btn("Tak, usuń", "del", () => { confirmId = null; deleteDoc(doc(calvesCol(farm), c.id)); status("Usunięto."); }));
  } else {
    if (typOf(c) === "cielak" && c.plec !== "b") btns.append(btn("Do jałówek", "ghost", () => { writeCalf(c.id, { ...rowData(c), typ: "jalowka", plec: "j" }); status(`${c.kolczyk} przeniesiona do jałówek.`); }));
    if (typOf(c) === "jalowka") btns.append(btn("Do stada krów", "ghost", () => toHerd(c, {})));
    btns.append(btn("Edytuj", "ghost", () => openCalf(c)), btn("Usuń", "ghost", () => { confirmId = c.id; render(); }));
  }
  foot.append(btns);
  card.append(foot);
  return card;
}

/** Jałówka przechodzi do stada krów (np. po pierwszym zacieleniu). */
function toHerd(c, preset) {
  if (cows.some((x) => x.kolczyk === c.kolczyk)) { status("Krowa z tym kolczykiem już jest w stadzie."); return; }
  const data = { kolczyk: c.kolczyk, miejsce: c.miejsce || "", ojciec: c.ojciec || "", urodzona: c.urodzona || "", matka: c.matka || "",
    wycielenie: "", ruja: "", zacielenie: "", byk: "", cielna: "", zasuszona: false, przegnana: false };
  writeCow(c.id, data);
  deleteDoc(doc(calvesCol(farm), c.id)).catch(() => {});
  status(`${c.kolczyk} przeniesiona do stada krów.`);
  if (preset.zacielenie) { openCow({ id: c.id, ...data }, preset); setTimeout(() => $("byk").focus(), 50); status("Wpisz, jakim bykiem zacielona, i naciśnij Zapisz."); }
}

function removeCow(id) {
  confirmId = null;
  deleteDoc(doc(cowsCol(farm), id)).catch(() => status("Nie udało się usunąć."));
  status("Usunięto krowę.");
}

function viewSettings(v) {
  // --- miejsca ---
  const s1 = el("section", "card");
  s1.append(el("h2", null, "Miejsca w oborze"), el("p", "hint", "Kojce i budynki, np. Średnia obora, Porodówka, Jałowizna. Potem wybierasz je z listy przy krowie, a każde miejsce ma swoją zakładkę."));
  const ul = el("div", "plist");
  const ps = places();
  ps.forEach((p, i) => {
    const row = el("div", "prow");
    const n = cows.filter(inPlace(p)).length + calves.filter(inPlace(p)).length;
    const name = el("span", "pname", p);
    row.append(name, el("small", null, `${n} szt.`));
    const acts = el("span", "pacts");
    acts.append(
      btn("↑", "ghost sm", () => { if (i === 0) return; const a = [...ps]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; saveCfg({ ...cfg, miejsca: a }); render(); }),
      btn("Zmień nazwę", "ghost sm", () => renamePlace(row, p)),
      btn("Usuń", "ghost sm", () => deletePlaceAsk(row, p, n)),
    );
    row.append(acts);
    ul.append(row);
  });
  if (!ps.length) ul.append(el("div", "empty", "Brak miejsc. Dodaj pierwsze poniżej."));
  const add = el("form", "row addplace");
  const inp = el("input"); inp.id = "newPlace"; inp.placeholder = "Nowe miejsce, np. Średnia obora"; inp.autocomplete = "off";
  add.append(inp, (() => { const b = el("button", "primary", "Dodaj"); b.type = "submit"; return b; })());
  add.onsubmit = (e) => {
    e.preventDefault();
    const name = inp.value.trim().replace(/\s+/g, " ");
    if (!name) return;
    if (places().some((p) => p.toLowerCase() === name.toLowerCase())) { status("Takie miejsce już jest."); return; }
    saveCfg({ ...cfg, miejsca: [...places(), name] }, `Dodano miejsce: ${name}`);
    render();
    setTimeout(() => $("newPlace")?.focus(), 30);
  };
  s1.append(ul, add);
  v.append(s1);

  // --- terminy ---
  const s2 = el("section", "card");
  s2.append(el("h2", null, "Terminy"), el("p", "hint", "Wspólne dla wszystkich telefonów. Zapisują się same."));
  const fields = [
    ["setDry", "dry", "Zasuszenie: dni przed porodem", 1, 120, "dni"],
    ["setMove", "move", "Porodówka: dni przed porodem", 1, 60, "dni"],
    ["setCheck", "check", "Badanie cielności: dni po zacieleniu", 1, 120, "dni"],
    ["setVwp", "vwp", "Zacielić: dni po wycieleniu", 1, 200, "dni"],
    ["setKrycie", "krycie", "Jałówka gotowa do krycia po", 6, 36, "mies."],
    ["setAhead", "ahead", "Pokazuj zadania z wyprzedzeniem", 0, 30, "dni"],
    ["setHour", "hour", "Godzina porannego powiadomienia", 0, 23, ":00"],
  ];
  let timer = null;
  for (const [id, k, label, min, max, unit] of fields) {
    const lab = el("label"); lab.htmlFor = id; lab.append(document.createTextNode(label));
    const row = el("span", "numrow");
    const i = el("input"); i.id = id; i.type = "number"; i.inputMode = "numeric"; i.min = min; i.max = max; i.value = cfg[k];
    i.oninput = () => {
      const n = parseInt(i.value, 10);
      if (!Number.isFinite(n)) return;
      cfg = { ...cfg, [k]: Math.min(max, Math.max(min, n)) };
      clearTimeout(timer);
      timer = setTimeout(() => saveCfg(cfg, "Zapisano. Obowiązuje na wszystkich telefonach."), 700);
    };
    row.append(i, el("span", null, unit)); lab.append(row); s2.append(lab);
  }
  v.append(s2);

  // --- telefon ---
  const s3 = el("section", "card");
  s3.append(el("h2", null, "Ten telefon"));
  const r = el("div", "row");
  r.append(btn("Próbne powiadomienie", "ghost", testNotif), btn("Sprawdź aktualizacje", "ghost", checkUpdate));
  s3.append(r);
  s3.append(el("p", "hint", "Kod gospodarstwa (wpisz go na innych telefonach):"));
  const cr = el("div", "row");
  const code = el("span", "code", farm); code.style.fontSize = "1.5rem";
  cr.append(code, btn("Kopiuj", "ghost", async () => {
    try { await navigator.clipboard.writeText(farm); status("Skopiowano kod."); }
    catch { const rg = document.createRange(); rg.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(rg); }
  }));
  s3.append(cr);
  const lb = el("div");
  lb.append(btn("Przełącz na inne gospodarstwo", "ghost", () => {
    lb.replaceChildren(el("p", "hint", "Ten telefon odłączy się od stada. Dane zostaną w bazie – wrócisz do nich, wpisując kod."),
      btn("Nie", "ghost", () => render()), btn("Odłącz", "del", () => { LS.set("obora_farm", null); LS.set("obora_tab", null); location.reload(); }));
  }));
  s3.append(lb);
  v.append(s3);
}

function renamePlace(row, old) {
  row.replaceChildren();
  const i = el("input"); i.value = old; i.className = "noswipe";
  const ok = btn("Zapisz", "primary sm", async () => {
    const name = i.value.trim().replace(/\s+/g, " ");
    if (!name || name === old) { render(); return; }
    if (places().some((p) => p !== old && p.toLowerCase() === name.toLowerCase())) { status("Takie miejsce już jest."); return; }
    const b = writeBatch(db);
    cows.filter(inPlace(old)).forEach((c) => b.update(doc(cowsCol(farm), c.id), { miejsce: name }));
    calves.filter(inPlace(old)).forEach((c) => b.update(doc(calvesCol(farm), c.id), { miejsce: name }));
    b.commit().catch(() => status("Nie udało się zmienić nazwy przy zwierzętach."));
    if (tab === "m:" + old) tab = "m:" + name;
    await saveCfg({ ...cfg, miejsca: places().map((p) => (p === old ? name : p)) }, `Zmieniono nazwę na: ${name}`);
    render();
  });
  row.append(i, ok, btn("Anuluj", "ghost sm", () => render()));
  i.focus();
}
function deletePlaceAsk(row, p, n) {
  row.replaceChildren(el("span", "note", n ? `Usunąć „${p}”? ${n} szt. trafi do „Bez miejsca”.` : `Usunąć „${p}”?`),
    btn("Nie", "ghost sm", () => render()),
    btn("Usuń", "del sm", () => {
      const b = writeBatch(db);
      cows.filter(inPlace(p)).forEach((c) => b.update(doc(cowsCol(farm), c.id), { miejsce: "" }));
      calves.filter(inPlace(p)).forEach((c) => b.update(doc(calvesCol(farm), c.id), { miejsce: "" }));
      b.commit().catch(() => {});
      saveCfg({ ...cfg, miejsca: places().filter((x) => x !== p) }, `Usunięto miejsce: ${p}`);
      render();
    }));
}

function fillLists() {
  const bulls = [...new Set([...cows, ...calves].flatMap((c) => [c.ojciec, c.byk]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $("bykList").replaceChildren(...bulls.map((n) => { const o = el("option"); o.value = n; return o; }));
  $("matkiList").replaceChildren(...cows.map((c) => { const o = el("option"); o.value = c.kolczyk; return o; }));
}

// ---------------- formularz krowy ----------------
function closeDialogs() { for (const id of ["cowDlg", "calfDlg", "pickDlg"]) { const d = $(id); if (d.open) d.close(); } }
function currentPlace() { return tab.startsWith("m:") && tab !== "m:" + NO_PLACE ? tab.slice(2) : ""; }
function updatePreview() {
  const z = $("zacielenie").value, r = $("ruja").value;
  const due = z ? L.addDays(z, L.GESTATION) : null;
  $("dueOut").textContent = due ? L.fmt(due) : "—";
  $("checkOut").textContent = z ? `${L.fmt(L.addDays(z, cfg.check))} (+${cfg.check} dni)` : "—";
  $("dryOut").textContent = due ? `${L.fmt(L.addDays(due, -cfg.dry))} (${cfg.dry} dni przed)` : "—";
  $("moveOut").textContent = due ? `${L.fmt(L.addDays(due, -cfg.move))} (${cfg.move} dni przed)` : "—";
  $("rujaOut").textContent = r ? L.fmt(L.addDays(r, L.CYCLE)) : "—";
}
function openCow(c, preset = {}) {
  closeDialogs();
  editId = c ? c.id : null;
  const v = { ...(c || {}), ...preset };
  $("form").reset(); $("err").hidden = true;
  $("kolczyk").value = v.kolczyk || ""; $("wycielenie").value = v.wycielenie || ""; $("ruja").value = v.ruja || ""; $("zacielenie").value = v.zacielenie || "";
  $("ojciec").value = v.ojciec || "";
  $("byk").value = c && preset.zacielenie && preset.zacielenie !== c.zacielenie ? "" : (v.byk || "");
  placeSelect($("miejsce"), c ? placeOf(c) : currentPlace());
  updatePreview();
  $("formTitle").textContent = c ? "Edytuj krowę" : "Dodaj krowę";
  $("saveBtn").textContent = c ? "Zapisz zmiany" : "Zapisz krowę";
  armAbort("abortBtn", "abortHint", "Krowa będzie niecielna, a terminy liczą się od nowa – jak po wycieleniu.");
  $("abortBox").hidden = !c;
  $("cowDlg").showModal();
  if (!c) $("kolczyk").focus();
}
["zacielenie", "ruja"].forEach((id) => $(id).addEventListener("input", updatePreview));
$("cancelBtn").onclick = () => { editId = null; $("cowDlg").close(); };
$("cowDlg").addEventListener("close", () => { editId = null; });
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const showErr = (t) => { $("err").textContent = t; $("err").hidden = false; };
  const kolczyk = $("kolczyk").value.trim().toUpperCase().replace(/\s+/g, "");
  const wycielenie = $("wycielenie").value, ruja = $("ruja").value, zacielenie = $("zacielenie").value;
  const ojciec = $("ojciec").value.trim(), byk = $("byk").value.trim(), miejsce = $("miejsce").value;
  if (!kolczyk) return showErr("Wpisz numer kolczyka.");
  if (cows.some((c) => c.kolczyk === kolczyk && c.id !== editId)) return showErr("Krowa z tym kolczykiem już jest w stadzie.");
  const old = cows.find((c) => c.id === editId);
  const same = old && old.zacielenie === zacielenie;
  const data = {
    ...(old ? rowData(old) : {}),
    kolczyk, miejsce, ojciec, wycielenie, ruja, zacielenie, byk: zacielenie ? byk : "",
    cielna: same ? old.cielna || "" : "",
    zasuszona: same ? !!old.zasuszona : false,
    przegnana: same ? !!old.przegnana : false,
  };
  writeCow(editId || newId("k"), data);
  status(editId ? `Zapisano zmiany: ${kolczyk}` : `Dodano: ${kolczyk}${miejsce ? " → " + miejsce : ""}`);
  editId = null;
  $("cowDlg").close();
});

// ---------------- wytrucie ----------------
/** Przycisk z potwierdzeniem: pierwsze stuknięcie pyta, drugie wykonuje. */
function armAbort(btnId, hintId, hint) {
  const b = $(btnId); b.dataset.armed = ""; b.textContent = "Wytrucie"; b.classList.remove("del");
  $(hintId).textContent = hint;
}
function confirmAbort(btnId, hintId) {
  const b = $(btnId);
  if (b.dataset.armed) return true;
  b.dataset.armed = "1"; b.textContent = "Tak, potwierdzam wytrucie"; b.classList.add("del");
  $(hintId).textContent = "Stuknij jeszcze raz, żeby potwierdzić.";
  return false;
}
$("abortBtn").onclick = () => {
  if (!confirmAbort("abortBtn", "abortHint")) return;
  const c = cows.find((x) => x.id === editId);
  if (!c) return;
  const today = L.todayISO();
  patch(c, { wycielenie: today, wytrucie: today, zacielenie: "", byk: "", ruja: "", cielna: "", zasuszona: false, przegnana: false },
    `${c.kolczyk}: wytrucie zapisane – niecielna, terminy od nowa.`);
  editId = null; $("cowDlg").close();
};
$("cAbortBtn").onclick = () => {
  if (!confirmAbort("cAbortBtn", "cAbortHint")) return;
  const c = calves.find((x) => x.id === calfEditId);
  if (!c) return;
  if (cows.some((x) => x.kolczyk === c.kolczyk)) { status("Krowa z tym kolczykiem już jest w stadzie."); return; }
  const today = L.todayISO();
  writeCow(c.id, { kolczyk: c.kolczyk, miejsce: c.miejsce || "", ojciec: c.ojciec || "", urodzona: c.urodzona || "", matka: c.matka || "",
    wycielenie: today, wytrucie: today, ruja: "", zacielenie: "", byk: "", cielna: "", zasuszona: false, przegnana: false });
  deleteDoc(doc(calvesCol(farm), c.id)).catch(() => {});
  status(`${c.kolczyk}: wytrucie zapisane – przeniesiona do krów, terminy od dziś.`);
  $("calfDlg").close();
};

// ---------------- formularz młodzieży ----------------
function updateCalfPreview() {
  const born = $("cUrodzona").value, j = calfMode === "jalowka" || $("cJ").checked;
  $("cKrycieM").textContent = cfg.krycie;
  $("cBreedBox").hidden = !j;
  const d = born && j ? L.addMonths(born, cfg.krycie) : null;
  $("cBreedOut").textContent = d ? L.fmt(d) : "—";
}
function openCalf(c, mode) {
  closeDialogs();
  calfEditId = c ? c.id : null;
  calfMode = c ? typOf(c) : mode;
  $("cSeg").hidden = calfMode !== "cielak";
  $("calfForm").reset(); $("cErr").hidden = true;
  $("cKolczyk").value = c?.kolczyk || ""; $("cUrodzona").value = c?.urodzona || "";
  $("cMatka").value = c?.matka || ""; $("cOjciec").value = c?.ojciec || "";
  (c?.plec === "b" ? $("cB") : $("cJ")).checked = true;
  placeSelect($("cMiejsce"), c ? placeOf(c) : currentPlace());
  $("calfTitle").textContent = (c ? "Edytuj " : "Dodaj ") + (calfMode === "cielak" ? "cielaka" : "jałówkę");
  armAbort("cAbortBtn", "cAbortHint", "Jałówka przejdzie do krów jak po wycieleniu – terminy liczą się od dziś.");
  $("cAbortBox").hidden = !(c && calfMode === "jalowka");
  updateCalfPreview();
  $("calfDlg").showModal();
  if (!c) $("cKolczyk").focus();
}
$("cWiek").addEventListener("input", () => {
  const m = parseInt($("cWiek").value, 10);
  if (Number.isFinite(m) && m >= 0) $("cUrodzona").value = L.addMonths(L.todayISO(), -m);
  updateCalfPreview();
});
$("cUrodzona").addEventListener("input", () => { $("cWiek").value = ""; updateCalfPreview(); });
["cJ", "cB"].forEach((id) => $(id).addEventListener("change", updateCalfPreview));
$("calfCancel").onclick = () => $("calfDlg").close();
$("calfDlg").addEventListener("close", () => { calfEditId = null; });
$("calfForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = (t) => { $("cErr").textContent = t; $("cErr").hidden = false; };
  const kolczyk = $("cKolczyk").value.trim().toUpperCase().replace(/\s+/g, "");
  const urodzona = $("cUrodzona").value;
  if (!kolczyk) return err("Wpisz numer kolczyka.");
  if (!urodzona) return err("Wpisz datę urodzenia albo wiek w miesiącach.");
  if (urodzona > L.todayISO()) return err("Data urodzenia nie może być z przyszłości.");
  if (calves.some((c) => c.kolczyk === kolczyk && c.id !== calfEditId) || cows.some((c) => c.kolczyk === kolczyk)) return err("Zwierzę z tym kolczykiem już jest.");
  const data = {
    kolczyk, urodzona, typ: calfMode, plec: calfMode === "cielak" && $("cB").checked ? "b" : "j",
    miejsce: $("cMiejsce").value, matka: $("cMatka").value.trim().toUpperCase().replace(/\s+/g, ""), ojciec: $("cOjciec").value.trim(),
  };
  writeCalf(calfEditId || newId("c"), data);
  status(calfEditId ? `Zapisano: ${kolczyk}` : `Dodano: ${kolczyk}`);
  $("calfDlg").close();
});

// wybór: cielak / jałówka / krowa
$("fab").onclick = () => {
  if (tab === "cielaki") return openCalf(null, "cielak");
  if (tab === "jalowki") return openCalf(null, "jalowka");
  closeDialogs(); $("pickDlg").showModal();
};
$("pickCielak").onclick = () => openCalf(null, "cielak");
$("pickJalowka").onclick = () => openCalf(null, "jalowka");
$("pickKrowa").onclick = () => openCow(null);
$("pickCancel").onclick = () => $("pickDlg").close();

// ---------------- start ----------------
if (farm) start(farm); else { $("setup").hidden = false; $("app").hidden = true; }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && farm) render(); });
