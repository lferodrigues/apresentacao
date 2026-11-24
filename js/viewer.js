import {
  ref, get, set, push, onValue, onDisconnect, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { db, configOk } from "./firebase.js";
import { SlideRenderer } from "./pdf-render.js";
import { AnnotationLayer, strokesFromSnap } from "./annotations.js";
import { ScreenReceiver } from "./screen.js";
import {
  isValidPin, downloadPdf, sessionPdfPath, toggleFullscreen, escapeHtml,
  trackServerTime, serverNow, renderDownloadBox
} from "./common.js";

const $ = (id) => document.getElementById(id);
const joinSec = $("join"), viewerSec = $("viewer");
const form = $("join-form"), pinInput = $("pin"), joinBtn = $("join-btn"), joinErr = $("join-error");
const stage = $("v-stage"), msg = $("v-msg");
const renderer = new SlideRenderer($("v-canvas"), stage);
const ann = new AnnotationLayer($("v-ann"));
renderer.onLayout = (w, h, dpr) => ann.resize(w, h, dpr);

let state = null; // { pin, unsub, annUnsub, annPage, presence, loaded, loading, last, rx }
const video = $("v-video"), unmuteBtn = $("v-unmute");

unmuteBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  video.muted = false;
  video.play().catch(() => {});
  unmuteBtn.hidden = true;
});

if (!configOk) {
  $("config-alert").hidden = false;
  joinBtn.disabled = true;
} else {
  trackServerTime(db);
}

pinInput.addEventListener("input", () => {
  pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 4);
  joinErr.textContent = "";
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  join(pinInput.value.trim());
});

$("v-leave").addEventListener("click", leave);
$("v-fullscreen").addEventListener("click", () => toggleFullscreen(stage));
stage.addEventListener("dblclick", (e) => { if (!e.target.closest(".stage-msg")) toggleFullscreen(stage); });
document.addEventListener("keydown", (e) => {
  if (!viewerSec.hidden && (e.key === "f" || e.key === "F")) toggleFullscreen(stage);
});

// Entrada direta pelo link: ?pin=1234
const urlPin = new URLSearchParams(location.search).get("pin");
if (urlPin && isValidPin(urlPin) && configOk) {
  pinInput.value = urlPin;
  join(urlPin);
}

function showMsg(text) {
  msg.innerHTML = text ? `<div>${text}</div>` : "";
  msg.hidden = !text;
}

async function join(pin) {
  if (!isValidPin(pin)) {
    joinErr.textContent = "O PIN deve ter exatamente 4 números.";
    pinInput.focus();
    return;
  }
  joinBtn.disabled = true;
  joinBtn.textContent = "Procurando…";
  try {
    const snap = await get(ref(db, `sessions/${pin}`));
    const d = snap.val();
    if (!d || (d.ended && d.expiresAt && d.expiresAt < serverNow())) {
      joinErr.textContent = "PIN não encontrado ou apresentação encerrada.";
      return;
    }
    enter(pin);
  } catch (err) {
    console.error(err);
    joinErr.textContent = "Não foi possível conectar. Verifique sua internet.";
  } finally {
    joinBtn.disabled = !configOk;
    joinBtn.textContent = "Assistir";
  }
}

function setBadge(live) {
  $("v-badge").className = live ? "badge live" : "badge ended";
  $("v-badge").textContent = live ? "● AO VIVO" : "ENCERRADA";
}

function enter(pin) {
  history.replaceState(null, "", `?pin=${pin}`);
  joinSec.hidden = true;
  viewerSec.hidden = false;
  document.body.classList.add("presenting");
  setBadge(true);
  showMsg('<span class="spinner"></span>Conectando…');

  state = { pin, loaded: false, loading: false, last: null, annPage: null };

  // Presença (contador de visitantes do apresentador)
  const me = push(ref(db, `viewers/${pin}`));
  state.presence = me;
  set(me, serverTimestamp()).catch(() => {});
  onDisconnect(me).remove().catch(() => {});

  const current = state;
  state.unsub = onValue(ref(db, `sessions/${pin}`), async (snap) => {
    if (state !== current) return;
    if (!snap.exists()) return ended(null);

    const d = snap.val();
    current.last = d;
    $("v-title").innerHTML = escapeHtml(d.title || "Apresentação");
    document.title = `${d.title || "Apresentação"} · ao vivo`;

    if (d.ended) return ended(d);
    if (d.mode === "screen") return handleScreen(current, d);
    if (current.isEnded) { current.isEnded = false; setBadge(true); stage.classList.remove("ended"); }

    if (!d.ready) {
      showMsg('<span class="spinner"></span>Aguardando o apresentador terminar de enviar o arquivo…');
      return;
    }

    if (!current.loaded && !current.loading) {
      current.loading = true;
      try {
        showMsg('<span class="spinner"></span>Baixando apresentação… 0%');
        const bytes = await downloadPdf(db, sessionPdfPath(pin, d), d.chunks, (p) =>
          showMsg(`<span class="spinner"></span>Baixando apresentação… ${Math.round(p * 100)}%`));
        if (state !== current) return;
        await renderer.load(bytes);
        current.loaded = true;
      } catch (err) {
        console.error(err);
        showMsg("Erro ao carregar a apresentação. Atualize a página para tentar de novo.");
        return;
      } finally {
        current.loading = false;
      }
    }

    if (current.loaded && !current.last.ended) {
      showMsg("");
      const page = current.last.currentPage || 1;
      $("v-page").textContent = `Slide ${page} de ${current.last.numPages || renderer.numPages}`;
      renderer.show(page);
      watchAnnotations(page);
    }
  }, (err) => {
    console.error(err);
    showMsg("Conexão perdida com a apresentação.");
  });
}

/* ---------- Espelhamento de tela (vídeo ao vivo) ---------- */
function handleScreen(cur, d) {
  if (!cur.rx) {
    stage.classList.add("is-video");
    $("v-page").textContent = "Tela ao vivo";
    video.muted = true;
    cur.rx = new ScreenReceiver(db, cur.pin, video, {
      onState: (st) => { cur.rtcState = st; refreshScreen(cur); },
    });
    cur.rx.start();
  }
  cur.live = !!d.live;
  refreshScreen(cur);
}

function refreshScreen(cur) {
  if (state !== cur) return;
  const connected = cur.rtcState === "connected";
  if (!cur.live) showMsg('<span class="spinner"></span>Aguardando o apresentador começar a transmissão…');
  else if (!connected) showMsg('<span class="spinner"></span>Conectando à transmissão…');
  else showMsg("");
  unmuteBtn.hidden = !(cur.live && connected && video.muted);
}

/** Acompanha as anotações (lápis/marca-texto) do slide atual. */
function watchAnnotations(page) {
  if (!state || state.annPage === page) return;
  state.annUnsub?.();
  state.annPage = page;
  ann.setStrokes([]);
  const current = state, pin = state.pin;
  state.annUnsub = onValue(ref(db, `annotations/${pin}/${page}`), (snap) => {
    if (state !== current || current.annPage !== page) return;
    ann.setStrokes(strokesFromSnap(snap));
  });
}

function ended(d) {
  if (!state) return;
  state.isEnded = true;
  stopScreenRx();
  state.annUnsub?.(); state.annUnsub = null; state.annPage = null;
  setBadge(false);
  $("v-page").textContent = "";
  stage.classList.add("ended");
  ann.clear();
  renderer.unload();
  state.loaded = false;

  if (d && d.expiresAt && d.expiresAt > serverNow()) {
    msg.hidden = false;
    renderDownloadBox(msg, state.pin, {
      title: d.title,
      expiresAt: d.expiresAt,
      backLabel: "Sair",
      onBack: leave,
    });
  } else {
    showMsg('A apresentação foi encerrada pelo apresentador.<br><button class="btn primary sm" id="v-back">Voltar</button>');
    $("v-back")?.addEventListener("click", leave);
  }
}

function leave() {
  if (state) {
    state.unsub?.();
    state.annUnsub?.();
    stopScreenRx();
    if (state.presence) {
      onDisconnect(state.presence).cancel().catch(() => {});
      remove(state.presence).catch(() => {});
    }
  }
  state = null;
  ann.clear();
  renderer.unload();
  if (document.fullscreenElement) document.exitFullscreen?.();
  stage.classList.remove("fake-fs", "ended");
  document.body.classList.remove("presenting", "no-scroll");
  viewerSec.hidden = true;
  joinSec.hidden = false;
  document.title = "Apresentação ao vivo";
  history.replaceState(null, "", location.pathname);
  pinInput.value = "";
  pinInput.focus();
}

function stopScreenRx() {
  if (state?.rx) { state.rx.stop(); state.rx = null; }
  stage.classList.remove("is-video");
  unmuteBtn.hidden = true;
  video.srcObject = null;
}
