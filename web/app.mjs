import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc, getDoc, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import * as L from "./logic.mjs";

export const APP_VERSION = "3.6";
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
const histCol = (f) => collection(db, "gospodarstwa", f, "historia");
const queueCol = (f) => collection(db, "gospodarstwa", f, "dozacielenia");
const photoRef = (f, id) => doc(db, "gospodarstwa", f, "zdjecia", id);

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
let cows = [], calves = [], queue = [], history = [];
let queueLoaded = false;
const autoDone = new Set();
/** Krowa biega (ruja) i jest niecielna → sama trafia na listę „Do zacielenia”. Zacielone znikają z listy. */
function autoQueue() {
  if (!farm || !loaded || !queueLoaded) return;
  const today = L.todayISO();
  for (const { cow: c, date } of L.rujaQueue(cows, today)) {
    const key = c.id + date;
    if (autoDone.has(key)) continue;
    autoDone.add(key);
    if (!queue.some((q) => sameTag(q.kolczyk, c.kolczyk)))
      setDoc(doc(queueCol(farm), L.rujaQueueId(c, date)), { kolczyk: c.kolczyk, miejsce: placeOf(c), dodano: today, zmieniono: Date.now(), auto: "ruja", ruja: date }).catch(() => {});
    writeCow(c.id, { ...rowData(c), kolejkaRuja: date });
  }
  for (const q of queue) {
    const a = findAnimal(q.kolczyk);
    if (a && a.zacielenie && q.dodano && (a.zacielenie2 || a.zacielenie) >= q.dodano && L.pregnant(a) && !autoDone.has("del" + q.id)) {
      autoDone.add("del" + q.id);
      deleteDoc(doc(queueCol(farm), q.id)).catch(() => {});
    }
  }
}
let queueDoneId = null;   // wpis z listy „Do zacielenia”, który zniknie po zapisaniu zacielenia
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
    autoQueue();
    const off = "Bez internetu – zmiany wyślą się później.";
    if (snap.metadata.fromCache) status(off); else if ($("status").textContent === off) status("");
    render();
  }, () => status("Brak dostępu do bazy. Sprawdź internet.")));
  unsub.push(onSnapshot(histCol(code), (snap) => {
    history = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    pruneHistory();
    if (tab === "glowna") render();
  }, () => {}));
  unsub.push(onSnapshot(queueCol(code), (snap) => {
    queue = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    queueLoaded = !snap.metadata?.fromCache || queueLoaded;
    autoQueue();
    render();
  }, () => {}));
  unsub.push(onSnapshot(calvesCol(code), (snap) => {
    calves = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, () => {}));
  unsub.push(onSnapshot(cfgDocRef(code), (s) => {
    cfg = L.cfgOf(s.data()); cfgLoaded = true;
    if (s.exists() && s.data().check === 35 && !s.data().checkV2) saveCfg({ ...cfg, check: 30, checkV2: 1 });
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
    body: list.slice(0, 6).map((a) => `${a.cow.kolczyk}${a.cow.nazwa ? " (" + a.cow.nazwa + ")" : ""}: ${a.title} ${L.kiedy(a.n)}`).join("\n") || "Na dziś brak zadań.",
    icon: "ikona-192.png", badge: "odznaka-96.png", tag: "obora-test",
  });
  status("Wysłano – sprawdź pasek powiadomień.");
}
const allAlerts = (cs, ks, ahead, dueAhead) =>
  [...L.alerts(cs, cfg, ahead, dueAhead), ...L.calfAlerts(ks, cfg, ahead, undefined, dueAhead)].sort((a, b) => (a.sort ?? a.n) - (b.sort ?? b.n));

// ---------------- zapis ----------------
const rowData = (c) => { const { id, ...r } = c; return r; };
function writeCow(id, data) {
  data.termin = L.due(data) || "";
  data.zmieniono = Date.now();
  const before = cows.find((x) => x.id === id);
  logChange("krowy", id, before ? rowData(before) : null, data);
  setDoc(doc(cowsCol(farm), id), data).catch(() => status("Nie udało się zapisać. Sprawdź internet."));
}
function patch(c, changes, msg) { writeCow(c.id, { ...rowData(c), ...changes }); if (msg) status(msg); }
function writeCalf(id, data) {
  data.zmieniono = Date.now();
  const before = calves.find((x) => x.id === id);
  logChange("mlodziez", id, before ? rowData(before) : null, data);
  setDoc(doc(calvesCol(farm), id), data).catch(() => status("Nie udało się zapisać. Sprawdź internet."));
}
function saveCfg(next, msg) {
  cfg = next;
  return setDoc(cfgDocRef(farm), cfg).then(() => { if (msg) status(msg); }).catch(() => status("Nie udało się zapisać ustawień."));
}

// ---------------- elementy ----------------
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---- Kolczyk: podpowiedzi podobnych numerów i blokada powtórzeń ----
const tagNorm = (s) => (s || "").toUpperCase().replace(/\s+/g, "");
const tagDigits = (s) => (s || "").replace(/\D/g, "");
// ten sam kolczyk: identyczny albo te same cyfry (np. "PL005123" = "005123")
function sameTag(a, b) {
  const x = tagNorm(a), y = tagNorm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const dx = tagDigits(x);
  return dx.length >= 3 && dx === tagDigits(y);
}
const allAnimals = () => [...cows, ...calves];
const tagOwner = (k, selfId) => allAnimals().find((a) => a.id !== selfId && sameTag(a.kolczyk, k)) || null;
const animalKind = (a) => (cows.includes(a) ? "krowa" : typOf(a) === "jalowka" ? "jałówka" : a.plec === "b" ? "byczek" : "cielak");
const animalDesc = (a) => (a.nazwa ? a.nazwa + " · " : "") + animalKind(a) + (placeOf(a) ? " · " + placeOf(a) : "");
/** Żółty kolczyk z nazwą krowy obok (jeśli wpisana). */
function tagEl(a, k = a?.kolczyk) {
  const t = el("span", "tag", k);
  if (a?.nazwa) t.append(el("span", "tname", a.nazwa));
  return t;
}
/** Pod polem kolczyka: lista sztuk o tym samym początku numeru; ten sam numer = czerwony błąd. */
function tagAssist(input, { selfId = () => null, dupError = true, saveBtn = null, onPick = null } = {}) {
  const box = el("div", "tagsug"); box.hidden = true; box.setAttribute("aria-live", "polite");
  (input.closest(".tagrow") || input.closest("label") || input).after(box);
  const setBad = (bad) => { input.classList.toggle("bad", bad); if (saveBtn) saveBtn.disabled = bad; };
  const refresh = () => {
    const v = tagNorm(input.value), d = tagDigits(v);
    box.replaceChildren(); box.classList.remove("dup");
    if (!v) { box.hidden = true; setBad(false); return; }
    const own = tagOwner(v, selfId());
    if (own && dupError) {
      box.classList.add("dup");
      box.append(el("b", null, "Ten kolczyk już jest w gospodarstwie!"), el("span", null, `${own.kolczyk} – ${animalDesc(own)}`));
      box.hidden = false; setBad(true); return;
    }
    setBad(false);
    const match = (a) => {
      if (a.id === selfId()) return false;
      const t = tagNorm(a.kolczyk);
      return (d.length >= 2 && tagDigits(t).startsWith(d)) || (v.length >= 2 && t.startsWith(v));
    };
    const list = d.length >= 2 || v.length >= 2
      ? allAnimals().filter(match).sort((a, b) => tagDigits(a.kolczyk).localeCompare(tagDigits(b.kolczyk))) : [];
    if (!list.length) { box.hidden = true; return; }
    box.append(el("span", "tshead", `Podobne numery (${list.length}):`));
    const wrap = el("div", "tsl");
    for (const a of list.slice(0, 12)) {
      const it = el(onPick ? "button" : "span", "tsi");
      if (onPick) { it.type = "button"; it.onclick = () => onPick(a); }
      const t = el("span", "tst"), k = a.kolczyk, plen = d.length >= 2 ? prefixLen(k, d) : v.length;
      t.append(el("b", null, k.slice(0, plen)), document.createTextNode(k.slice(plen)));
      it.append(t, el("small", null, animalDesc(a)));
      wrap.append(it);
    }
    if (list.length > 12) wrap.append(el("span", "tsmore", `+ jeszcze ${list.length - 12}`));
    box.append(wrap); box.hidden = false;
  };
  // ile znaków kolczyka obejmuje wpisane cyfry (pomija litery jak "PL")
  const prefixLen = (k, d) => { let n = 0, i = 0; while (i < k.length && n < d.length) { if (/\d/.test(k[i])) n++; i++; } return i; };
  input.addEventListener("input", refresh);
  return { refresh, reset: () => { box.hidden = true; box.replaceChildren(); setBad(false); } };
}
function btn(text, cls, fn) { const b = el("button", cls, text); b.type = "button"; b.onclick = fn; return b; }
function placeSelect(sel, value) {
  sel.replaceChildren();
  const o0 = el("option", null, "— bez miejsca —"); o0.value = ""; sel.append(o0);
  for (const p of places()) { const o = el("option", null, p); o.value = p; sel.append(o); }
  sel.value = value || "";
}

// ---------------- zakładki ----------------
function tabList() {
  const t = [{ key: "glowna", label: "Główna" }, { key: "zacielenie", label: "Do zacielenia", n: queue.length }];
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
  else if (tab === "zacielenie") viewQueue(v);
  else if (tab === "cielaki" || tab === "jalowki") viewCalves(v, tab === "cielaki" ? "cielak" : "jalowka");
  else if (tab === "ustawienia") viewSettings(v);
  else viewPlace(v, tab.slice(2));
  $("fab").textContent = tab === "cielaki" ? "+ Dodaj cielaka" : tab === "jalowki" ? "+ Dodaj jałówkę" : "+ Dodaj";
  $("fab").hidden = tab === "ustawienia" || tab === "zacielenie";
  if (dir) { v.classList.remove("in-l", "in-r"); void v.offsetWidth; v.classList.add(dir > 0 ? "in-r" : "in-l"); }
}

function statsRow(cs, ks = calves) {
  const today = L.todayISO();
  const row = el("div", "stats");
  const st = (n, label) => { const d = el("div", "stat"); d.append(el("b", null, String(n)), el("span", null, label)); return d; };
  row.append(
    st(cs.length, "Krów"),
    st(cs.filter((c) => L.pregnant(c)).length + ks.filter((c) => typOf(c) === "jalowka" && L.pregnant(c)).length, "Zacielonych"),
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
  historySection(v);
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
  const hit = (a) => !q || [a.kolczyk, a.nazwa, a.ojciec, a.byk, a.matka, a.miejsce, a.antybiotyk].some((x) => (x || "").toUpperCase().includes(q));
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
    v.append(el("p", "hint", `Jałówki są gotowe do krycia po ${cfg.krycie} miesiącach (zmienisz w Ustawieniach). Datę zacielenia wpiszesz w Edytuj – policzy się termin porodu.`));
  }
  alertsSection(v, [], ks, "Do zrobienia");
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
    const cls = a.kind === "karencja" ? "soon kar" : a.kind === "karencjaOk" ? "good" : a.kind === "due" || (a.n <= 0 && a.kind === "check") ? "soon" : a.n <= 0 ? "warn" : "";
    const row = el("div", "alert " + cls);
    const t = el("div", "atxt");
    t.append(el("b", null, `${a.title} ${L.kiedy(a.n)}`), el("small", null, a.sub + (placeOf(c) && !tab.startsWith("m:") ? ` · ${placeOf(c)}` : "")));
    const ab = el("div", "abtns");
    const x = btn("✕", "ghost xclose", () => hideAlert(a));
    x.setAttribute("aria-label", "Ukryj to zadanie"); x.title = "Ukryj to zadanie";
    const head = el("div", "ahead"); head.append(tagEl(c), x);
    row.append(head, t, ab);
    const upd = a.calf ? (ch, msg) => { writeCalf(c.id, { ...rowData(c), ...ch }); status(msg); } : (ch, msg) => patch(c, ch, msg);
    const zacielona = () => insemCow(c, today);
    if (a.kind === "check") ab.append(btn("Cielna", "okbtn", () => upd({ cielna: "tak" }, `${c.kolczyk}: cielna`)), btn("Niecielna", "nobtn", () => upd({ cielna: "nie" }, `${c.kolczyk}: niecielna`)));
    if (a.kind === "dry") ab.append(btn("Zasuszona", "okbtn", () => openDry(c)));
    if (a.kind === "move") ab.append(btn("Przegnana", "okbtn", () => upd({ przegnana: true }, `${c.kolczyk}: na porodówce`)));
    if (a.kind === "ruja") ab.append(btn("Grzeje się dziś", "nobtn", () => patch(c, { ruja: today }, `${c.kolczyk}: ruja zapisana`)), btn("Zacielona dziś", "okbtn", zacielona));
    if (a.kind === "insem") ab.append(btn("Zacielona dziś", "okbtn", zacielona));
    if (a.kind === "due") ab.append(btn("Wycieliła się", "okbtn", () => a.calf ? toHerd(c, { wycielenie: today }) : calved(c, today)));
    if (a.kind === "karencjaOk") ab.append(btn("OK, doję", "okbtn", () => patch(c, { karencjaOk: true }, `${c.kolczyk}: karencja zakończona`)));
    if (a.kind === "krycie") ab.append(btn("Zacielona dziś", "okbtn", () => heiferInsem(c, today)), btn("Do stada krów", "nobtn", () => toHerd(c, {})));
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
  left.append(tagEl(c));
  if (c.zasuszona) {
    const ch = el("span", "chip dry", c.antybiotyk ? `Zasuszona · ${c.antybiotyk}` : "Zasuszona");
    if (c.karencja) ch.append(" ", el("small", "dni", `(${c.karencja} dni)`));
    left.append(ch);
  }
  if (c.karencjaKoniec && !c.karencjaOk) {
    const kn = L.daysBetween(L.todayISO(), c.karencjaKoniec);
    left.append(el("span", "chip " + (kn > 0 ? "no" : "yes"), kn > 0 ? `Karencja: jeszcze ${L.dni(kn)}` : "Można doić"));
  }
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
    ["Zacielona bykiem", (c.byk || "—") + (c.zacielenie2 ? ` / 2.: ${c.byk2 || "—"}` : "")],
    [c.wytrucie && c.wytrucie === c.wycielenie ? "Wytrucie" : "Ost. wycielenie", L.fmt(c.wycielenie) + (c.ostatniByk && c.wycielenie ? ` (po ${c.ostatniByk})` : "")],
    ["Ostatnia ruja", L.fmt(c.ruja)],
    ["Następna ruja", L.fmt(L.nextRuja(c, today))],
    ["Zacielenie", L.fmt(c.zacielenie) + (c.zacielenie2 ? ` i ${L.fmt(c.zacielenie2)}` : "")],
    ["Sprawdzić cielność", L.fmt(L.checkDate(c, cfg))],
    ["Zasuszenie", c.zasuszona ? antNode([c.zasuszonaData ? L.fmt(c.zasuszonaData) : "zrobione", c.antybiotyk].filter(Boolean).join(" · "), c.antybiotyk ? c.karencja : 0) : L.fmt(L.dryDate(c, cfg))],
    ["Na porodówkę", c.przegnana ? "zrobione" : L.fmt(L.moveDate(c, cfg))],
    ["Termin porodu", L.fmt(due) + (L.due2(c) ? ` lub ${L.fmt(L.due2(c))}` : "")],
  ];
  const kids = childrenOf(c);
  if (kids.length) items.push(["Cielęta", kids.map((k) => `${k.kolczyk}${k.nazwa ? " " + k.nazwa : ""}${k.urodzona ? ` (${L.fmt(k.urodzona)})` : ""}`).join(", ")]);
  for (const [k, val] of items) {
    const w = el("div"), dd = el("dd", k === "Termin porodu" && due ? "big" : null);
    if (val instanceof Node) dd.append(val); else dd.textContent = val;
    w.append(el("dt", null, k), dd); dl.append(w);
  }
  card.append(top, dl);
  withPhoto(top, c);
  const foot = el("div", "cowfoot");
  foot.append(moveSelect(c, (p) => patch(c, { miejsce: p }, `${c.kolczyk} → ${p || "bez miejsca"}`)));
  const btns = el("div", "cowbtns");
  if (confirmId === c.id) {
    const q2 = el("span", "note", "Usunąć tę krowę?");
    btns.append(q2, btn("Nie", "ghost", () => { confirmId = null; render(); }), btn("Tak, usuń", "del", () => removeCow(c.id)));
  } else {
    if (c.zacielenie && c.cielna) btns.append(btn("Cofnij badanie", "ghost", () => patch(c, { cielna: "" }, `${c.kolczyk}: wynik cofnięty`)));
    if (c.zacielenie && !c.cielna) btns.append(
      btn("Cielna ✓", "okbtn", () => patch(c, { cielna: "tak" }, `${c.kolczyk}: cielna`)),
      btn("Niecielna", "ghost", () => patch(c, { cielna: "nie" }, `${c.kolczyk}: niecielna`)));
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
  left.append(tagEl(c), el("span", "chip " + (c.plec === "b" ? "" : "yes"), kindLabel(c)));
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
  const ins = typOf(c) === "jalowka" && c.zacielenie;
  if (ins) {
    const d = L.due(c);
    items.push(["Zacielona", L.fmt(c.zacielenie)], ["Zacielona bykiem", c.byk || "—"],
      ["Sprawdzić cielność", c.cielna ? "—" : L.fmt(L.checkDate(c, cfg))], ["Termin porodu", d ? `${L.fmt(d)} (${L.kiedy(L.daysBetween(today, d))})` : "—"]);
    left.append(el("span", "chip " + (c.cielna === "tak" ? "yes" : c.cielna === "nie" ? "no" : ""), c.cielna === "tak" ? "Cielna" : c.cielna === "nie" ? "Niecielna" : "Zacielona"));
  } else if (c.plec !== "b") items.push(["Do krycia", breedTxt], ["Miesięcy", c.urodzona ? String(L.monthsOld(c.urodzona, today)) : "—"]);
  for (const [k, val] of items) { const w = el("div"); w.append(el("dt", null, k), el("dd", (k === "Do krycia" && bd && L.daysBetween(today, bd) <= 0) || k === "Termin porodu" ? "big" : null, val)); dl.append(w); }
  card.append(top, dl);
  withPhoto(top, c);
  const foot = el("div", "cowfoot");
  foot.append(moveSelect(c, (p) => { writeCalf(c.id, { ...rowData(c), miejsce: p }); status(`${c.kolczyk} → ${p || "bez miejsca"}`); }));
  const btns = el("div", "cowbtns");
  if (confirmId === c.id) {
    btns.append(el("span", "note", "Usunąć?"), btn("Nie", "ghost", () => { confirmId = null; render(); }), btn("Tak, usuń", "del", () => { confirmId = null; deleteAnimal("mlodziez", c); status("Usunięto. Możesz to cofnąć w Historii zmian na Głównej."); }));
  } else {
    if (typOf(c) === "cielak" && c.plec !== "b") btns.append(btn("Do jałówek", "ghost", () => { writeCalf(c.id, { ...rowData(c), typ: "jalowka", plec: "j" }); status(`${c.kolczyk} przeniesiona do jałówek.`); }));
    if (typOf(c) === "jalowka") btns.append(btn("Do stada krów", "ghost", () => toHerd(c, {})));
    btns.append(btn("Edytuj", "ghost", () => openCalf(c)), btn("Usuń", "ghost", () => { confirmId = c.id; render(); }));
  }
  foot.append(btns);
  card.append(foot);
  return card;
}

/** Zdjęcie zwierzęcia jako delikatne tło całej karty (za danymi). */
function withPhoto(top, a) {
  const url = photoFor(a);
  if (!url) return;
  const card = top.parentElement || top;
  card.classList.add("pic");
  card.style.setProperty("--photo", `url("${url}")`);
}

/** Zacielenie krowy dziś. Gdy niedawno zacielona i wróciła ruja → drugie zacielenie (pierwsze zostaje). */
function isReInsem(c, date) {
  if (!c.zacielenie || c.zacielenie2 || c.cielna === "tak" || !L.pregnant(c)) return false;
  const n = L.daysBetween(c.zacielenie, date);
  return n >= 5 && n <= 60;
}
function insemCow(c, date, extra = {}) {
  if (isReInsem(c, date)) {
    openCow(c, { zacielenie2: date, ruja: date, ...extra });
    status(`Druga inseminacja (pierwsza ${L.fmt(c.zacielenie)} zostaje). Wpisz drugie nasienie i naciśnij Zapisz.`);
    setTimeout(() => $("byk2").focus(), 50);
  } else {
    openCow(c, { zacielenie: date, ruja: date, ...extra });
    status("Wpisz, jakim bykiem zacielona, i naciśnij Zapisz.");
    setTimeout(() => $("byk").focus(), 50);
  }
}
/** Zacielenie jałówki: zostaje w jałówkach, formularz z dzisiejszą datą. */
function heiferInsem(c, date) {
  openCalf(c);
  $("cZacielenie").value = date; $("cByk").value = ""; $("cCielna").value = "";
  updateCalfPreview();
  status("Wpisz, jakim bykiem zacielona, i naciśnij Zapisz.");
  setTimeout(() => $("cByk").focus(), 50);
}
/** Jałówka przechodzi do stada krów (np. po pierwszym zacieleniu). */
function toHerd(c, preset) {
  if (cows.some((x) => x.kolczyk === c.kolczyk)) { status("Krowa z tym kolczykiem już jest w stadzie."); return; }
  const data = { kolczyk: c.kolczyk, nazwa: c.nazwa || "", miejsce: c.miejsce || "", ojciec: c.ojciec || "", urodzona: c.urodzona || "", matka: c.matka || "", foto: c.foto || 0,
    wycielenie: preset.wycielenie || "", ruja: "", zacielenie: c.zacielenie || "", byk: c.byk || "", cielna: c.cielna || "", zasuszona: false, przegnana: !!c.przegnana };
  writeCow(c.id, data);
  deleteAnimal("mlodziez", c, true);
  status(preset.wycielenie ? `${c.kolczyk}: wycielenie zapisane – teraz jest w stadzie krów.` : `${c.kolczyk} przeniesiona do stada krów.`);
  if (preset.zacielenie) { openCow({ id: c.id, ...data }, preset); setTimeout(() => $("byk").focus(), 50); status("Wpisz, jakim bykiem zacielona, i naciśnij Zapisz."); }
}

function removeCow(id) {
  confirmId = null;
  const c = cows.find((x) => x.id === id);
  if (c) deleteAnimal("krowy", c);
  status("Usunięto krowę. Możesz to cofnąć w Historii zmian na Głównej.");
}

// ---------------- historia zmian (24 h) z cofaniem ----------------
const DAY_MS = 24 * 3600 * 1000;
let grp = null, undoing = false;
/** Wszystkie zapisy z jednego stuknięcia trafiają do jednej grupy (cofane razem). */
function group() { if (!grp) { grp = newId("g"); queueMicrotask(() => { grp = null; }); } return grp; }
const LABELS = { kolczyk: "kolczyk", nazwa: "nazwa", zacielenie2: "2. zacielenie", byk2: "2. byk", miejsce: "miejsce", ojciec: "ojciec", wycielenie: "wycielenie", ruja: "ruja", zacielenie: "zacielenie",
  byk: "byk", cielna: "cielność", zasuszona: "zasuszenie", zasuszonaData: "data zasuszenia", antybiotyk: "antybiotyk", karencja: "karencja",
  karencjaOk: "karencja", karencjaKoniec: "karencja", przegnana: "porodówka", foto: "zdjęcie", ukryj: "ukryte zadanie", wytrucie: "wytrucie",
  urodzona: "data urodzenia", plec: "płeć", typ: "typ", matka: "matka" };
function describe(kol, before, after) {
  const typ = kol === "krowy" ? "krowę" : "jałówkę/cielaka";
  if (!before) return `Dodano ${typ} ${after.kolczyk}`;
  if (!after) return `Usunięto ${typ} ${before.kolczyk}`;
  const ch = [...new Set(Object.keys(LABELS).filter((k) => JSON.stringify(before[k] ?? "") !== JSON.stringify(after[k] ?? "")).map((k) => LABELS[k]))];
  return ch.length ? `${after.kolczyk}: ${ch.join(", ")}` : null;
}
function logChange(kol, id, before, after, extra = {}) {
  if (undoing || !farm) return;
  const opis = describe(kol, before, after);
  if (!opis) return;
  setDoc(doc(histCol(farm), newId("h")), { czas: Date.now(), grupa: group(), kol, docId: id, przed: before, usun: !after, opis, ...extra }).catch(() => {});
}
function deleteAnimal(kol, a, quiet = false) {
  logChange(kol, a.id, rowData(a), null, quiet ? { cicho: true } : {});
  deleteDoc(doc(kol === "krowy" ? cowsCol(farm) : calvesCol(farm), a.id)).catch(() => status("Nie udało się usunąć."));
}
/** Cofa całą grupę zmian: przywraca stan sprzed nich. */
async function undoGroup(g) {
  const entries = history.filter((h) => h.grupa === g).sort((a, b) => b.czas - a.czas);
  undoing = true;
  try {
    for (const h of entries) {
      const ref = doc(h.kol === "krowy" ? cowsCol(farm) : calvesCol(farm), h.docId);
      if (h.przed) await setDoc(ref, h.przed); else await deleteDoc(ref);
    }
    const b = writeBatch(db); entries.forEach((h) => b.delete(doc(histCol(farm), h.id))); await b.commit();
    status(`Cofnięto: ${entries.filter((h) => !h.cicho).map((h) => h.opis).join(" + ")}`);
  } catch { status("Nie udało się cofnąć. Sprawdź internet."); }
  undoing = false;
}
/** Usuwa wpisy starsze niż 24 h (i zdjęcia zwierząt usuniętych na stałe). */
let pruning = false;
function pruneHistory() {
  if (pruning) return;
  const old = history.filter((h) => Date.now() - (h.czas || 0) > DAY_MS);
  if (!old.length) return;
  pruning = true;
  const b = writeBatch(db);
  for (const h of old) {
    b.delete(doc(histCol(farm), h.id));
    if (h.usun && !cows.some((c) => c.id === h.docId) && !calves.some((c) => c.id === h.docId)) b.delete(photoRef(farm, h.docId));
  }
  b.commit().catch(() => {}).finally(() => { pruning = false; });
}
function historySection(v) {
  const recent = history.filter((h) => Date.now() - (h.czas || 0) <= DAY_MS);
  const groups = new Map();
  for (const h of recent.sort((a, b) => b.czas - a.czas)) {
    if (!groups.has(h.grupa)) groups.set(h.grupa, []);
    groups.get(h.grupa).push(h);
  }
  const box = el("details", "card hist");
  const sum = el("summary"); sum.append(el("b", null, "Historia zmian"), el("small", null, ` ostatnie 24 h · ${groups.size}`));
  box.append(sum);
  if (!groups.size) box.append(el("p", "hint", "Brak zmian w ostatnich 24 godzinach. Tu zobaczysz każdą zmianę i będziesz mógł ją cofnąć – np. gdy ktoś przypadkiem usunie krowę."));
  const list = el("div", "hlist");
  [...groups.entries()].slice(0, 60).forEach(([g, es]) => {
    const row = el("div", "hrow");
    const t = new Date(Math.max(...es.map((e) => e.czas)));
    const txt = el("div", "htxt");
    txt.append(el("small", null, t.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })), el("span", null, es.filter((e) => !e.cicho).map((e) => e.opis).reverse().join(" + ")));
    const b = btn("Cofnij", "ghost sm", () => {
      if (b.dataset.armed) { b.disabled = true; undoGroup(g); return; }
      b.dataset.armed = "1"; b.textContent = "Na pewno cofnąć?"; b.classList.add("del");
    });
    row.append(txt, b);
    list.append(row);
  });
  box.append(list);
  box.append(el("p", "hint", "Cofnięcie przywraca stan sprzed zmiany. Wpisy starsze niż 24 godziny znikają same."));
  v.append(box);
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
    ["setZalegle", "zalegle", "Ukrywaj zadania spóźnione o więcej niż", 1, 365, "dni"],
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

  v.append(backupSection());

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
  antDays.clear();
  for (const c of cows) {
    if (c.antybiotyk && c.karencja) antDays.set(c.antybiotyk, Number(c.karencja));
    if (c.karencjaLek && c.karencjaDni) antDays.set(c.karencjaLek, Number(c.karencjaDni));
  }
  const ants = [...new Set([...cows.map((c) => c.antybiotyk), ...antDays.keys()].filter(Boolean))].sort((a, b) => a.localeCompare(b, "pl"));
  $("antList").replaceChildren(...ants.map((n) => { const o = el("option"); o.value = n; if (antDays.get(n)) o.label = `${n} (${antDays.get(n)} dni)`; return o; }));
  const bulls = [...new Set([...cows, ...calves].flatMap((c) => [c.ojciec, c.byk]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $("bykList").replaceChildren(...bulls.map((n) => { const o = el("option"); o.value = n; return o; }));
  $("matkiList").replaceChildren(...[...cows, ...calves.filter((c) => typOf(c) === "jalowka")].map((c) => { const o = el("option"); o.value = c.kolczyk; if (c.nazwa) o.label = c.nazwa; return o; }));
}

// ---------------- formularz krowy ----------------
function closeDialogs() { for (const id of ["cowDlg", "calfDlg", "pickDlg", "dryDlg"]) { const d = $(id); if (d.open) d.close(); } }
function currentPlace() { return tab.startsWith("m:") && tab !== "m:" + NO_PLACE ? tab.slice(2) : ""; }
function updatePreview() {
  const z = $("zacielenie").value, r = $("ruja").value;
  const due = z ? L.addDays(z, L.GESTATION) : null;
  $("dueOut").textContent = due ? L.fmt(due) : "—";
  $("checkOut").textContent = z ? `${L.fmt(L.addDays(z, cfg.check))} (+${cfg.check} dni)` : "—";
  $("dryOut").textContent = due ? `${L.fmt(L.addDays(due, -cfg.dry))} (${cfg.dry} dni przed)` : "—";
  $("moveOut").textContent = due ? `${L.fmt(L.addDays(due, -cfg.move))} (${cfg.move} dni przed)` : "—";
  $("rujaOut").textContent = r ? L.fmt(L.addDays(r, L.CYCLE)) : "—";
  const z2 = $("zacielenie2").value;
  $("due2Row").hidden = !z2;
  $("due2Out").textContent = z2 ? L.fmt(L.addDays(z2, L.GESTATION)) : "—";
  if (z2) $("checkOut").textContent = `${L.fmt(L.addDays(z2, cfg.check))} (+${cfg.check} dni od 2. zacielenia)`;
}
let editSeed = null;   // dane krowy, która jeszcze nie dotarła z bazy (np. właśnie przeniesiona jałówka)
function openCow(c, preset = {}) {
  const keepQueue = queueDoneId;
  closeDialogs();
  queueDoneId = keepQueue;
  editId = c ? c.id : null;
  editSeed = c;
  const v = { ...(c || {}), ...preset };
  $("form").reset(); $("err").hidden = true;
  $("kolczyk").value = v.kolczyk || ""; $("nazwa").value = v.nazwa || ""; $("wycielenie").value = v.wycielenie || ""; $("ruja").value = v.ruja || ""; $("zacielenie").value = v.zacielenie || "";
  $("ojciec").value = v.ojciec || ""; $("antybiotyk").value = v.antybiotyk || "";
  $("karencja").value = v.karencja || ""; $("karencjaOd").value = v.karencjaOd || "zasuszenie";
  $("cielnaSel").value = c && !(preset.zacielenie && preset.zacielenie !== c.zacielenie) ? (c.cielna || "") : "";
  $("zasData").value = v.zasuszona ? (v.zasuszonaData || "") : "";
  $("byk").value = c && preset.zacielenie && preset.zacielenie !== c.zacielenie ? "" : (v.byk || "");
  const fresh = c && preset.zacielenie && preset.zacielenie !== c.zacielenie;
  $("zacielenie2").value = fresh ? "" : (v.zacielenie2 || "");
  $("byk2").value = fresh || (preset.zacielenie2 && preset.zacielenie2 !== c?.zacielenie2) ? "" : (v.byk2 || "");
  if (preset.zacielenie2) $("cielnaSel").value = "";
  $("z2Box").open = !!$("zacielenie2").value;
  placeSelect($("miejsce"), preset.miejsce != null ? preset.miejsce : c ? placeOf(c) : currentPlace());
  photoUi("k", c ? photoFor(c) : null);
  updatePreview();
  $("formTitle").textContent = c ? "Edytuj krowę" : "Dodaj krowę";
  $("saveBtn").textContent = c ? "Zapisz zmiany" : "Zapisz krowę";
  armAbort("abortBtn", "abortHint", "Krowa będzie niecielna, a terminy liczą się od nowa – jak po wycieleniu.");
  $("abortBox").hidden = !c;
  cowTag.reset(); if (!c && v.kolczyk) cowTag.refresh();
  $("cowDlg").showModal();
  if (!c) $("kolczyk").focus();
}
const cowTag = tagAssist($("kolczyk"), { selfId: () => editId, saveBtn: $("saveBtn") });
["zacielenie", "ruja", "zacielenie2"].forEach((id) => $(id).addEventListener("input", updatePreview));
$("zacielenie2").addEventListener("input", () => { $("cielnaSel").value = ""; });
$("zacielenie").addEventListener("input", () => { $("cielnaSel").value = ""; });
$("cancelBtn").onclick = () => { editId = null; $("cowDlg").close(); };
$("cowDlg").addEventListener("close", () => { editId = null; editSeed = null; queueDoneId = null; });
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const showErr = (t) => { $("err").textContent = t; $("err").hidden = false; };
  const kolczyk = $("kolczyk").value.trim().toUpperCase().replace(/\s+/g, "");
  const wycielenie = $("wycielenie").value, ruja = $("ruja").value, zacielenie = $("zacielenie").value;
  const ojciec = $("ojciec").value.trim(), byk = $("byk").value.trim(), miejsce = $("miejsce").value, antybiotyk = $("antybiotyk").value.trim();
  if (!kolczyk) return showErr("Wpisz numer kolczyka.");
  { const own = tagOwner(kolczyk, editId); if (own) return showErr(`Ten kolczyk już jest: ${own.kolczyk} (${animalDesc(own)}).`); }
  const zacielenie2 = zacielenie ? $("zacielenie2").value : "";
  if (zacielenie2 && zacielenie2 <= zacielenie) return showErr("Drugie zacielenie musi być później niż pierwsze.");
  if (zacielenie2 && zacielenie2 > L.todayISO()) return showErr("Data drugiego zacielenia nie może być z przyszłości.");
  const old = cows.find((c) => c.id === editId) || (editId ? editSeed : null);
  const same = old && old.zacielenie === zacielenie;
  const data = {
    ...(old ? rowData(old) : {}),
    kolczyk, nazwa: $("nazwa").value.trim(), miejsce, ojciec, wycielenie, ruja, zacielenie, byk: zacielenie ? byk : "",
    zacielenie2, byk2: zacielenie2 ? $("byk2").value.trim() : "",
    cielna: zacielenie ? $("cielnaSel").value : "",
    zasuszona: !!$("zasData").value || (same ? !!old.zasuszona : false) || !!antybiotyk,
    przegnana: same ? !!old.przegnana : false,
    antybiotyk,
  };
  if ($("zasData").value) data.zasuszonaData = $("zasData").value;
  if (data.zasuszona && !data.zasuszonaData) data.zasuszonaData = L.todayISO();
  data.karencja = data.zasuszona ? Math.max(0, parseInt($("karencja").value, 10) || 0) : 0;
  data.karencjaOd = data.zasuszona ? $("karencjaOd").value : "";
  if (!data.zasuszona) { data.antybiotyk = ""; data.zasuszonaData = ""; }
  // nowa data wycielenia wpisana ręcznie u zasuszonej krowy = wycielenie z karencją
  if (old && old.zasuszona && wycielenie && wycielenie !== old.wycielenie && wycielenie >= (old.zasuszonaData || "")) {
    Object.assign(data, calvingChanges({ ...old, ...data, zasuszona: true }, wycielenie), { wycielenie });
  }
  const cid = editId || newId("k");
  data.foto = savePhoto("k", cid, old);
  writeCow(cid, data);
  if (queueDoneId && data.zacielenie) { deleteDoc(doc(queueCol(farm), queueDoneId)).catch(() => {}); }
  queueDoneId = null;
  status(editId ? `Zapisano zmiany: ${kolczyk}` : `Dodano: ${kolczyk}${miejsce ? " → " + miejsce : ""}`);
  editId = null;
  $("cowDlg").close();
});

// ---------------- zdjęcia ----------------
// ---------------- kopia zapasowa do pliku ----------------
const BACKUP_KIND = "obora-kopia";
function backupSection() {
  const s = el("section", "card");
  s.append(el("h2", null, "Kopia zapasowa"),
    el("p", "hint", "Zapisuje całe gospodarstwo do jednego pliku: krowy, jałówki, cielaki, miejsca, ustawienia i listę do zacielenia. Trzymaj go np. na Dysku Google, w mailu albo na komputerze. Z tego pliku przywrócisz wszystko bez ponownego wpisywania."));
  const last = LS.get("obora_kopia");
  const info = el("p", "hint bkinfo", last ? `Ostatnia kopia z tego telefonu: ${L.fmt(last)}` : "Z tego telefonu nie zrobiono jeszcze kopii.");
  if (!last || L.daysBetween(last, L.todayISO()) > 30) info.classList.add("warnt");
  const withPh = el("label", "chk");
  const cb = el("input"); cb.type = "checkbox"; cb.id = "bkPhotos"; cb.checked = true;
  withPh.append(cb, document.createTextNode(" Ze zdjęciami krów (plik będzie większy)"));
  const row = el("div", "bkrow");
  const saveB = btn("Zapisz kopię do pliku", "primary", () => exportBackup(cb.checked, saveB));
  const fileIn = el("input"); fileIn.type = "file"; fileIn.accept = ".json,application/json"; fileIn.className = "vh"; fileIn.id = "bkFile";
  const loadL = el("label", "phbtn", "Wczytaj kopię z pliku"); loadL.htmlFor = "bkFile";
  row.append(saveB, loadL, fileIn);
  const box = el("div", "bkbox");
  fileIn.onchange = () => { const f = fileIn.files?.[0]; fileIn.value = ""; if (f) readBackup(f, box); };
  s.append(info, withPh, row, box);
  return s;
}
async function exportBackup(photos, b) {
  b.disabled = true; const t = b.textContent; b.textContent = "Przygotowuję…";
  try {
    const zdjecia = {};
    if (photos) {
      const withFoto = [...cows, ...calves].filter((a) => a.foto);
      await Promise.all(withFoto.map(async (a) => {
        const hit = photoCache.get(a.id);
        if (hit && hit.v === a.foto) { zdjecia[a.id] = hit.url; return; }
        try { const d = (await getDoc(photoRef(farm, a.id))).data(); if (d?.data) zdjecia[a.id] = d.data; } catch {}
      }));
    }
    const data = {
      rodzaj: BACKUP_KIND, wersja: 1, aplikacja: APP_VERSION, zapisano: new Date().toISOString(), gospodarstwo: farm,
      ustawienia: cfg,
      krowy: cows.map((c) => ({ id: c.id, ...rowData(c) })),
      mlodziez: calves.map((c) => ({ id: c.id, ...rowData(c) })),
      dozacielenia: queue.map((q) => ({ id: q.id, ...rowData(q) })),
      zdjecia,
    };
    const today = L.todayISO();
    const name = `obora-kopia-${today}.json`;
    const file = new File([JSON.stringify(data)], name, { type: "application/json" });
    let done = false;
    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Kopia Obory" }); done = true; }
      catch (e) { if (e?.name === "AbortError") { status("Anulowano zapis kopii."); return; } }
    }
    if (!done) {
      const url = URL.createObjectURL(file);
      const a = el("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    LS.set("obora_kopia", today);
    const n = data.krowy.length + data.mlodziez.length;
    status(`Zapisano kopię: ${n} ${odm(n, "sztuka", "sztuki", "sztuk")}${photos ? ` i zdjęcia: ${Object.keys(zdjecia).length}` : ""} → plik ${name}${done ? "" : " (w Pobranych)"}.`);
    render();
  } catch { status("Nie udało się zapisać kopii."); }
  finally { b.disabled = false; b.textContent = t; }
}
function readBackup(f, box) {
  const r = new FileReader();
  r.onerror = () => status("Nie udało się odczytać pliku.");
  r.onload = () => {
    let d;
    try { d = JSON.parse(r.result); } catch { d = null; }
    if (!d || d.rodzaj !== BACKUP_KIND || !Array.isArray(d.krowy)) {
      box.replaceChildren(el("p", "err", "To nie jest plik kopii Obory.")); return;
    }
    const kr = d.krowy.length, ml = (d.mlodziez || []).length, ph = Object.keys(d.zdjecia || {}).length;
    const when = d.zapisano ? new Date(d.zapisano).toLocaleString("pl-PL", { dateStyle: "long", timeStyle: "short" }) : "?";
    const ids = new Set([...cows, ...calves].map((a) => a.id));
    const newer = [...d.krowy, ...(d.mlodziez || [])].filter((a) => !ids.has(a.id)).length;
    const card = el("div", "bkconfirm");
    card.append(el("b", null, `Kopia z ${when}`),
      el("p", null, `Krowy: ${kr} · jałówki i cielaki: ${ml}${ph ? ` · zdjęcia: ${ph}` : ""}.${newer ? ` Brakuje teraz ${newer} ${odm(newer, "sztuki", "sztuk", "sztuk")} z kopii – wrócą.` : ""}`),
      el("p", "hint", "Sztuki z kopii nadpiszą swoje obecne dane. Sztuki dodane po zrobieniu kopii zostaną bez zmian. Zmiany zobaczą wszystkie telefony."));
    const row = el("div", "row");
    row.append(btn("Anuluj", "ghost", () => box.replaceChildren()), btn("Przywróć dane", "primary", (e) => restoreBackup(d, box, e.currentTarget)));
    card.append(row);
    box.replaceChildren(card);
  };
  r.readAsText(f);
}
async function restoreBackup(d, box, b) {
  b.disabled = true; b.textContent = "Przywracam…";
  const ops = [];
  const clean = (o) => { const { id, ...r } = o || {}; return r; };
  for (const c of d.krowy) if (c?.id) ops.push([doc(cowsCol(farm), c.id), clean(c)]);
  for (const c of d.mlodziez || []) if (c?.id) ops.push([doc(calvesCol(farm), c.id), clean(c)]);
  for (const q of d.dozacielenia || []) if (q?.id) ops.push([doc(queueCol(farm), q.id), clean(q)]);
  for (const [id, data] of Object.entries(d.zdjecia || {})) if (typeof data === "string") ops.push([photoRef(farm, id), { data, zmieniono: Date.now() }]);
  if (d.ustawienia) ops.push([cfgDocRef(farm), { ...cfg, ...d.ustawienia }]);
  try {
    // zdjęcia są duże – mniejsze paczki
    let batch = writeBatch(db), n = 0, size = 0;
    for (const [ref, data] of ops) {
      const sz = JSON.stringify(data).length;
      if (n >= 400 || size + sz > 8e6) { await batch.commit(); batch = writeBatch(db); n = 0; size = 0; }
      batch.set(ref, data); n++; size += sz;
    }
    if (n) await batch.commit();
    photoCache.clear();
    box.replaceChildren(el("p", "okt", `Przywrócono z kopii – krowy: ${d.krowy.length}, jałówki i cielaki: ${(d.mlodziez || []).length}.`));
    status(`Przywrócono z kopii – krowy: ${d.krowy.length}, jałówki i cielaki: ${(d.mlodziez || []).length}.`);
  } catch {
    b.disabled = false; b.textContent = "Przywróć dane";
    status("Nie udało się przywrócić – sprawdź internet i spróbuj jeszcze raz.");
  }
}
const photoCache = new Map();   // id -> { v, url }
const photoLoading = new Set();
let photoRenderTimer = null;
/** Zdjęcie zwierzęcia (zapisane osobno, żeby lista ładowała się szybko). */
function photoFor(a) {
  if (!a.foto) return null;
  const hit = photoCache.get(a.id);
  if (hit && hit.v === a.foto) return hit.url;
  if (!photoLoading.has(a.id)) {
    photoLoading.add(a.id);
    getDoc(photoRef(farm, a.id)).then((s) => {
      const d = s.data();
      if (d?.data) photoCache.set(a.id, { v: a.foto, url: d.data });
    }).catch(() => {}).finally(() => {
      photoLoading.delete(a.id);
      clearTimeout(photoRenderTimer); photoRenderTimer = setTimeout(() => { if (!document.querySelector("dialog[open]")) render(); }, 150);
    });
  }
  return hit?.url || null;
}
/** Zmniejsza zdjęcie z aparatu do ~720 px (JPEG), żeby szybko się wysyłało. */
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const max = 720, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(img, 0, 0, w, h);
    let q = 0.62, out = cv.toDataURL("image/jpeg", q);
    while (out.length > 280000 && q > 0.3) { q -= 0.08; out = cv.toDataURL("image/jpeg", q); }
    return out;
  } finally { URL.revokeObjectURL(url); }
}
/** Obsługa przycisków aparatu w formularzu (prefix "k" – krowa, "c" – cielak/jałówka). */
const pendingPhoto = { k: undefined, c: undefined };   // undefined = bez zmian, "" = usuń, "data:..." = nowe
function photoUi(p, current) {
  pendingPhoto[p] = undefined;
  showPhoto(p, current);
}
function showPhoto(p, url) {
  const prev = $(p + "PhPrev");
  prev.hidden = !url; prev.style.backgroundImage = url ? `url("${url}")` : "";
  $(p + "PhDel").hidden = !url;
  $(p + "PhLbl").textContent = url ? "Zrób nowe zdjęcie" : "Zrób zdjęcie";
}
for (const p of ["k", "c"]) {
  $(p + "PhIn").addEventListener("change", async (e) => {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    $(p + "PhLbl").textContent = "Przygotowuję zdjęcie…";
    try { pendingPhoto[p] = await shrinkPhoto(f); showPhoto(p, pendingPhoto[p]); }
    catch { status("Nie udało się wczytać zdjęcia."); showPhoto(p, null); }
  });
  $(p + "PhDel").onclick = () => { pendingPhoto[p] = ""; showPhoto(p, null); };
}
/** Zapisuje zdjęcie (jeśli zmienione) i zwraca pole foto dla rekordu zwierzęcia. */
function savePhoto(p, id, old) {
  const ph = pendingPhoto[p];
  if (ph === undefined) return old?.foto || 0;
  if (ph === "") { deleteDoc(photoRef(farm, id)).catch(() => {}); photoCache.delete(id); return 0; }
  const v = Date.now();
  photoCache.set(id, { v, url: ph });
  setDoc(photoRef(farm, id), { data: ph, zmieniono: v }).catch(() => status("Nie udało się zapisać zdjęcia."));
  return v;
}

/** Krzyżyk przy zadaniu: ukrywa je dla tej sztuki (do zmiany terminu). */
function hideAlert(a) {
  const c = a.cow;
  const ukryj = { ...(c.ukryj || {}), [a.kind]: a.date };
  if (a.calf) writeCalf(c.id, { ...rowData(c), ukryj }); else patch(c, { ukryj });
  status(`${c.kolczyk}: ukryto „${a.title}”.`);
}

// ---------------- do zacielenia ----------------
const findAnimal = (k) => cows.find((c) => c.kolczyk === k) || calves.find((c) => c.kolczyk === k) || null;
function viewQueue(v) {
  const today = L.todayISO();
  const head = el("div", "placehead");
  head.append(el("h2", null, "Do zacielenia"), el("span", "count", `${queue.length} szt.`));
  v.append(head);

  // --- dodawanie: tablica miejsc z numerami ---
  const add = el("form", "card qadd"); add.noValidate = true;
  add.append(el("h3", "subh", "Stuknij numer, żeby dodać do listy"));
  const inQ = new Set(queue.map((q) => q.kolczyk));
  const pickable = [...cows, ...calves.filter((c) => typOf(c) === "jalowka")];
  const board = el("div", "qboard");
  const rows = [...places().map((p) => [p, p]), ["Bez miejsca", NO_PLACE]];
  for (const [label, key] of rows) {
    const list = pickable.filter(inPlace(key)).sort((a, b) => a.kolczyk.localeCompare(b.kolczyk, "pl", { numeric: true }));
    if (!list.length) continue;
    const row = el("div", "qrowp");
    const name = el("div", "qplace"); name.append(el("b", null, label), el("small", null, `${list.length} szt.`));
    const nums = el("div", "qnums");
    for (const a of list) {
      const on = inQ.has(a.kolczyk), preg = L.pregnant(a), jal = !cows.includes(a);
      const b = el("button", "qnum" + (on ? " on" : "") + (preg ? " preg" : "") + (jal ? " jal" : ""));
      b.type = "button";
      b.append(el("span", null, a.kolczyk)); if (a.nazwa) b.append(el("small", "qname", a.nazwa));
      if (on) b.append(el("small", null, "na liście ✓"));
      else if (preg) b.append(el("small", null, "cielna"));
      else if (jal) b.append(el("small", null, "jałówka"));
      b.setAttribute("aria-pressed", on);
      b.onclick = () => {
        if (on) { const q = queue.find((x) => x.kolczyk === a.kolczyk); if (q) deleteDoc(doc(queueCol(farm), q.id)); status(`${a.kolczyk} usunięta z listy.`); }
        else { setDoc(doc(queueCol(farm), newId("z")), { kolczyk: a.kolczyk, miejsce: placeOf(a), dodano: today, zmieniono: Date.now() }); status(`${a.kolczyk} dodana do listy.`); }
      };
      nums.append(b);
    }
    row.append(name, nums);
    board.append(row);
  }
  if (!board.children.length) board.append(el("div", "empty", "Nie masz jeszcze wpisanych krów ani jałówek. Wpisz kolczyk ręcznie poniżej."));
  add.append(board);
  const or = el("h3", "subh", "Albo wpisz kolczyk ręcznie");
  const kLab = el("label"); kLab.htmlFor = "qKolczyk"; kLab.append(document.createTextNode("Numer kolczyka"));
  const kIn = el("input"); kIn.id = "qKolczyk"; kIn.autocomplete = "off"; kIn.placeholder = "np. 005123456789"; kIn.inputMode = "numeric"; kLab.append(kIn);
  const pLab = el("label"); pLab.htmlFor = "qMiejsce"; pLab.append(document.createTextNode("Miejsce"));
  const pSel = el("select"); pSel.id = "qMiejsce"; placeSelect(pSel, ""); pLab.append(pSel);
  kIn.oninput = () => { const a = tagOwner(kIn.value); if (a) pSel.value = placeOf(a); };
  const err = el("p", "err"); err.hidden = true;
  const sub = el("button", "primary", "Dodaj do listy"); sub.type = "submit";
  const manual = el("div", "qmanual"); manual.append(or, kLab, pLab, err, sub);
  add.append(manual);
  tagAssist(kIn, { dupError: false, onPick: (a) => { kIn.value = a.kolczyk; kIn.dispatchEvent(new Event("input")); } });
  add.onsubmit = (e) => {
    e.preventDefault();
    const k = kIn.value.trim().toUpperCase().replace(/\s+/g, "");
    if (!k) { err.textContent = "Wpisz numer kolczyka."; err.hidden = false; return; }
    if (queue.some((q) => q.kolczyk === k)) { err.textContent = "Ta sztuka już jest na liście."; err.hidden = false; return; }
    const a = findAnimal(k);
    const miejsce = pSel.value || (a ? placeOf(a) : "");
    setDoc(doc(queueCol(farm), newId("z")), { kolczyk: k, miejsce, dodano: today, zmieniono: Date.now() }).catch(() => status("Nie udało się zapisać."));
    // ręcznie wpisane miejsce zapisz też przy zwierzęciu
    if (a && pSel.value && pSel.value !== placeOf(a)) {
      if (cows.includes(a)) patch(a, { miejsce: pSel.value }); else writeCalf(a.id, { ...rowData(a), miejsce: pSel.value });
    }
    status(`${k} dodana do listy do zacielenia.`);
  };
  let sugSec = null;

  // --- podpowiedzi: ruja / gotowe do zacielenia ---
  const sug = allAlerts(cows, calves, 1, -999).filter((a) => ["ruja", "insem", "krycie"].includes(a.kind) && !inQ.has(a.cow.kolczyk));
  if (sug.length) {
    const sec = el("section", "col");
    sec.append(el("h3", "subh", "Podpowiedzi: ruja i gotowe do zacielenia"));
    const box = el("div", "alerts");
    for (const a of sug) {
      const row = el("div", "alert");
      const t = el("div", "atxt");
      t.append(el("b", null, `${a.title} ${L.kiedy(a.n)}`), el("small", null, a.sub + (placeOf(a.cow) ? ` · ${placeOf(a.cow)}` : "")));
      const ab = el("div", "abtns");
      ab.append(btn("Dodaj do listy", "okbtn", () => setDoc(doc(queueCol(farm), newId("z")), { kolczyk: a.cow.kolczyk, miejsce: placeOf(a.cow), dodano: today, zmieniono: Date.now() })));
      row.append(tagEl(a.cow), t, ab);
      box.append(row);
    }
    sec.append(box); sugSec = sec;
  }

  // --- lista ---
  const sec = el("section", "col");
  sec.append(el("h3", "subh", `Lista (${queue.length})`));
  const list = el("div", "list");
  if (!queue.length) list.append(el("div", "empty", "Lista jest pusta. Dodaj krowy lub jałówki powyżej – np. przed przyjazdem inseminatora."));
  const byPlace = [...queue].sort((a, b) => (a.miejsce || "~").localeCompare(b.miejsce || "~", "pl") || (a.dodano || "").localeCompare(b.dodano || ""));
  for (const q of byPlace) {
    const a = findAnimal(q.kolczyk);
    const row = el("article", "cow qrow");
    const top = el("div", "cowtop");
    const left = el("div", "cowleft");
    left.append(tagEl(a, q.kolczyk));
    left.append(el("span", "chip", a ? (cows.includes(a) ? "Krowa" : kindLabel(a)) : "Spoza stada"));
    if (q.auto === "ruja") left.append(el("span", "chip ruja", `Ruja ${q.ruja ? L.fmt(q.ruja).slice(0, 5) : ""}`));
    if (a && L.pregnant(a)) left.append(el("span", "chip no", "Uwaga: cielna"));
    top.append(left, el("span", "pill none", q.dodano ? `dodana ${L.fmt(q.dodano)}` : ""));
    row.append(top);
    if (a) withPhoto(top, a);
    const foot = el("div", "cowfoot");
    const ps = el("select", "locsel noswipe"); ps.setAttribute("aria-label", "Miejsce"); placeSelect(ps, q.miejsce || "");
    ps.onchange = () => setDoc(doc(queueCol(farm), q.id), { ...rowData(q), miejsce: ps.value });
    const lw = el("label", "locwrap"); lw.append(el("span", null, "Miejsce"), ps);
    const btns = el("div", "cowbtns");
    btns.append(
      btn("Zacielona", "okbtn", () => inseminate(q)),
      btn("Usuń z listy", "ghost", () => { deleteDoc(doc(queueCol(farm), q.id)); status(`${q.kolczyk} usunięta z listy.`); }),
    );
    foot.append(lw, btns);
    row.append(foot);
    list.append(row);
  }
  sec.append(list);
  if (queue.length > 1) sec.append(btn("Wyczyść całą listę", "ghost", () => {
    const b = writeBatch(db); queue.forEach((q) => b.delete(doc(queueCol(farm), q.id))); b.commit(); status("Lista wyczyszczona.");
  }));
  v.append(sec, add);
  if (sugSec) v.append(sugSec);
}
/** Zacielenie z listy: otwiera formularz krowy z dzisiejszą datą (wpis znika po zapisaniu). */
function inseminate(q) {
  const today = L.todayISO();
  const a = findAnimal(q.kolczyk);
  queueDoneId = q.id;
  const preset = { zacielenie: today, ruja: today, miejsce: q.miejsce || (a ? placeOf(a) : "") };
  if (a && cows.includes(a)) insemCow(a, today, { miejsce: preset.miejsce });
  else if (a) heiferInsem(a, today);
  else { openCow(null, { ...preset, kolczyk: q.kolczyk }); status("Wpisz, jakim bykiem zacielona, i naciśnij Zapisz."); setTimeout(() => $("byk").focus(), 60); }
}

// ---------------- wycielenie i karencja ----------------
const antDays = new Map();   // antybiotyk -> dni karencji (ostatnio wpisane)
/** Tekst z nazwą antybiotyku i małym dopiskiem „(45 dni)”. */
function antNode(text, days) {
  const f = document.createDocumentFragment();
  f.append(text);
  if (days) f.append(" ", el("small", "dni", `(${days} dni)`));
  return f;
}
/** Po wpisaniu znanego antybiotyku podstaw jego liczbę dni, jeśli pole jest puste. */
for (const [antId, karId] of [["dryAnt", "dryKar"], ["antybiotyk", "karencja"]]) {
  $(antId).addEventListener("input", () => {
    const d = antDays.get($(antId).value.trim());
    if (d && !$(karId).value) $(karId).value = d;
  });
}
/** Zmiany przy wycieleniu: nowy cykl + wyliczenie końca karencji z antybiotyku z zasuszenia. */
function calvingChanges(c, date) {
  const koniec = c.zasuszona ? L.withdrawalEnd(c, date) : "";
  const g = L.guessSire(c, date);
  return {
    ostatniByk: g?.byk || "", ostatniByk2: !!(g && g.which === 2),
    wycielenie: date, zacielenie: "", byk: "", zacielenie2: "", byk2: "", ruja: "", cielna: "", przegnana: false,
    zasuszona: false, zasuszonaData: "", antybiotyk: "", karencja: 0, karencjaOd: "",
    karencjaKoniec: koniec, karencjaLek: koniec ? (c.antybiotyk || "") : "", karencjaDni: koniec ? Number(c.karencja) || 0 : 0, karencjaOk: false,
  };
}
/** Cielęta danej matki (po kolczyku matki), najmłodsze pierwsze. */
const childrenOf = (m) => [...calves, ...cows].filter((x) => x.id !== m.id && x.matka && sameTag(x.matka, m.kolczyk))
  .sort((a, b) => (b.urodzona || "").localeCompare(a.urodzona || ""));
/** Matka wpisana przy cielaku: krowa albo jałówka z gospodarstwa. */
const motherOf = (k, selfId) => (k ? [...cows, ...calves.filter((c) => typOf(c) === "jalowka")].find((a) => a.id !== selfId && sameTag(a.kolczyk, k)) || null : null);
/** Co zrobić z matką po urodzeniu cielaka w dniu date: null = nic. */
function motherPlan(m, date) {
  if (!m || !date) return null;
  if (m.wycielenie === date) return { skip: "Wycielenie matki z tego dnia już jest wpisane." };
  if (m.wycielenie && m.wycielenie > date) return { skip: `Matka ma późniejsze wycielenie (${L.fmt(m.wycielenie)}) – zostawiam.` };
  return { heifer: !cows.includes(m), onlyDate: !!(m.zacielenie && m.zacielenie > date) };
}
function applyMother(m, date, calfTag) {
  const p = motherPlan(m, date);
  if (!p || p.skip) return "";
  if (p.heifer) { toHerd(m, { wycielenie: date }); return ` · ${m.kolczyk}: wycielenie ${L.fmt(date)}, przeszła do krów`; }
  if (p.onlyDate) { patch(m, { wycielenie: date }); return ` · matce ${m.kolczyk} wpisano wycielenie ${L.fmt(date)}`; }
  const ch = calvingChanges(m, date);
  writeCow(m.id, { ...rowData(m), ...ch });
  return ` · matce ${m.kolczyk} wpisano wycielenie ${L.fmt(date)}` + (ch.karencjaKoniec ? ` (karencja do ${L.fmt(ch.karencjaKoniec)})` : "");
}
function updateMotherInfo() {
  const m = motherOf($("cMatka").value.trim(), calfEditId), date = $("cUrodzona").value;
  $("cMotherBox").hidden = !m;
  if (!m) return;
  $("cMotherInfo").textContent = `Matka: ${m.kolczyk}${m.nazwa ? " " + m.nazwa : ""} – ${animalKind(m)}${m.wycielenie ? `, ost. wycielenie ${L.fmt(m.wycielenie)}` : ""}.`;
  const p = motherPlan(m, date);
  // ojciec cielęcia: byk matki (przy dwóch zacieleniach – ten, którego termin pasuje)
  const g = p && !p.skip ? L.guessSire(m, date) : (m.wycielenie === date && m.ostatniByk ? { byk: m.ostatniByk } : null);
  const oj = $("cOjciec");
  if (g?.byk && (!oj.value || oj.dataset.auto)) { oj.value = g.byk; oj.dataset.auto = "1"; }
  if (g?.byk && g.which && m.zacielenie2) $("cMotherInfo").textContent += ` Dwa zacielenia – bliżej terminu z ${g.which}. (${L.fmt(g.which === 2 ? g.d2 : g.d1)}), więc ojciec: ${g.byk}.`;
  $("cMotherChkL").hidden = !p || !!p.skip;
  if (p?.skip) $("cMotherInfo").textContent += " " + p.skip;
  else if (p) $("cMotherChkT").textContent = p.heifer ? `Wpisz jej wycielenie ${L.fmt(date)} i przenieś do krów` : `Wpisz matce wycielenie ${L.fmt(date)}` + (p.onlyDate ? "" : " (terminy od nowa)");
}
function calved(c, date) {
  const ch = calvingChanges(c, date);
  const n = ch.karencjaKoniec ? L.daysBetween(L.todayISO(), ch.karencjaKoniec) : 0;
  const g = c.zacielenie2 ? L.guessSire(c, date) : null;
  patch(c, ch, `${c.kolczyk}: wycielenie zapisane` + (g ? ` – bliżej terminu z ${g.which}. zacielenia, cielę po: ${g.byk || "?"}` : "") + (ch.karencjaKoniec ? (n > 0 ? ` – karencja jeszcze ${L.dni(n)}, do ${L.fmt(ch.karencjaKoniec)}` : " – karencja już minęła, można doić") : ""));
}

// ---------------- zasuszenie ----------------
let dryId = null;
function openDry(c) {
  closeDialogs();
  dryId = c.id;
  $("dryCow").textContent = `Krowa ${c.kolczyk}${placeOf(c) ? " · " + placeOf(c) : ""}`;
  $("dryAnt").value = c.antybiotyk || "";
  $("dryDate").value = c.zasuszonaData || L.todayISO();
  $("dryKar").value = c.karencja || ""; $("dryKarOd").value = c.karencjaOd || "zasuszenie";
  $("dryDlg").showModal();
  $("dryAnt").focus();
}
$("dryCancel").onclick = () => $("dryDlg").close();
$("dryForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = cows.find((x) => x.id === dryId);
  if (!c) return $("dryDlg").close();
  const ant = $("dryAnt").value.trim();
  const kar = Math.max(0, parseInt($("dryKar").value, 10) || 0);
  patch(c, { zasuszona: true, antybiotyk: ant, zasuszonaData: $("dryDate").value || L.todayISO(), karencja: kar, karencjaOd: $("dryKarOd").value },
    `${c.kolczyk}: zasuszona${ant ? " – " + ant : ""}`);
  $("dryDlg").close();
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
  patch(c, { ...calvingChanges(c, today), wytrucie: today },
    `${c.kolczyk}: wytrucie zapisane – niecielna, terminy od nowa.`);
  editId = null; $("cowDlg").close();
};
$("cAbortBtn").onclick = () => {
  if (!confirmAbort("cAbortBtn", "cAbortHint")) return;
  const c = calves.find((x) => x.id === calfEditId);
  if (!c) return;
  if (cows.some((x) => x.kolczyk === c.kolczyk)) { status("Krowa z tym kolczykiem już jest w stadzie."); return; }
  const today = L.todayISO();
  writeCow(c.id, { kolczyk: c.kolczyk, nazwa: c.nazwa || "", miejsce: c.miejsce || "", ojciec: c.ojciec || "", urodzona: c.urodzona || "", matka: c.matka || "", foto: c.foto || 0,
    wycielenie: today, wytrucie: today, ruja: "", zacielenie: "", byk: "", cielna: "", zasuszona: false, przegnana: false });
  deleteAnimal("mlodziez", c, true);
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
  const jal = calfMode === "jalowka";
  $("cInsBox").hidden = !jal;
  const z = $("cZacielenie").value;
  $("cBreedBox").hidden = !j || (jal && !!z);
  const h = { zacielenie: z, cielna: $("cCielna").value };
  $("cDueOut").textContent = L.fmt(L.due(h));
  $("cCheckOut").textContent = L.fmt(L.checkDate(h, cfg));
  $("cMoveOut").textContent = L.fmt(L.moveDate(h, cfg));
}
function openCalf(c, mode) {
  closeDialogs();
  calfEditId = c ? c.id : null;
  calfMode = c ? typOf(c) : mode;
  $("cSeg").hidden = calfMode !== "cielak";
  $("calfForm").reset(); $("cErr").hidden = true;
  $("cKolczyk").value = c?.kolczyk || ""; $("cNazwa").value = c?.nazwa || ""; $("cUrodzona").value = c?.urodzona || "";
  $("cMatka").value = c?.matka || ""; $("cOjciec").value = c?.ojciec || "";
  $("cZacielenie").value = c?.zacielenie || ""; $("cByk").value = c?.byk || ""; $("cCielna").value = c?.cielna || "";
  (c?.plec === "b" ? $("cB") : $("cJ")).checked = true;
  placeSelect($("cMiejsce"), c ? placeOf(c) : currentPlace());
  photoUi("c", c ? photoFor(c) : null);
  $("calfTitle").textContent = (c ? "Edytuj " : "Dodaj ") + (calfMode === "cielak" ? "cielaka" : "jałówkę");
  armAbort("cAbortBtn", "cAbortHint", "Jałówka przejdzie do krów jak po wycieleniu – terminy liczą się od dziś.");
  $("cAbortBox").hidden = !(c && calfMode === "jalowka");
  updateCalfPreview();
  delete $("cOjciec").dataset.auto;
  $("cMotherChk").checked = true; updateMotherInfo();
  calfTag.reset();
  $("calfDlg").showModal();
  if (!c) $("cKolczyk").focus();
}
const calfTag = tagAssist($("cKolczyk"), { selfId: () => calfEditId, saveBtn: $("calfForm").querySelector('button[type="submit"]') });
$("cWiek").addEventListener("input", () => {
  const m = parseInt($("cWiek").value, 10);
  if (Number.isFinite(m) && m >= 0) $("cUrodzona").value = L.addMonths(L.todayISO(), -m);
  updateCalfPreview(); updateMotherInfo();
});
$("cUrodzona").addEventListener("input", () => { $("cWiek").value = ""; updateCalfPreview(); updateMotherInfo(); });
$("cMatka").addEventListener("input", updateMotherInfo);
$("cOjciec").addEventListener("input", () => { delete $("cOjciec").dataset.auto; });
tagAssist($("cMatka"), { dupError: false, onPick: (a) => { $("cMatka").value = a.kolczyk; $("cMatka").dispatchEvent(new Event("input")); } });
["cJ", "cB", "cCielna"].forEach((id) => $(id).addEventListener("change", updateCalfPreview));
$("cZacielenie").addEventListener("input", () => { $("cCielna").value = ""; updateCalfPreview(); });
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
  { const own = tagOwner(kolczyk, calfEditId); if (own) return err(`Ten kolczyk już jest: ${own.kolczyk} (${animalDesc(own)}).`); }
  const data = {
    kolczyk, nazwa: $("cNazwa").value.trim(), urodzona, typ: calfMode, plec: calfMode === "cielak" && $("cB").checked ? "b" : "j",
    miejsce: $("cMiejsce").value, matka: $("cMatka").value.trim().toUpperCase().replace(/\s+/g, ""), ojciec: $("cOjciec").value.trim(),
  };
  const oldC = calves.find((x) => x.id === calfEditId);
  if (calfMode === "jalowka") {
    const z = $("cZacielenie").value;
    if (z && z > L.todayISO()) return err("Data zacielenia nie może być z przyszłości.");
    if (z && z < urodzona) return err("Data zacielenia jest przed urodzeniem.");
    Object.assign(data, { zacielenie: z, byk: z ? $("cByk").value.trim() : "", cielna: z ? $("cCielna").value : "", przegnana: !!(oldC && oldC.zacielenie === z && oldC.przegnana) });
  }
  if (oldC) for (const k of ["ukryj"]) if (oldC[k]) data[k] = oldC[k];
  const kid = calfEditId || newId("c");
  data.foto = savePhoto("c", kid, calves.find((x) => x.id === calfEditId));
  const mom = motherOf(data.matka, kid);
  const momMsg = mom && !$("cMotherBox").hidden && !$("cMotherChkL").hidden && $("cMotherChk").checked ? applyMother(mom, urodzona) : "";
  writeCalf(kid, data);
  status((calfEditId ? `Zapisano: ${kolczyk}` : `Dodano: ${kolczyk}`) + momMsg);
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
