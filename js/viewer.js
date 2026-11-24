import {
  ref, get, set, push, onValue, onDisconnect, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { db, configOk } from "./firebase.js";
import { SlideRenderer } from "./pdf-render.js";
import { isValidPin, downloadPdf, toggleFullscreen, escapeHtml } from "./common.js";

const $ = (id) => document.getElementById(id);
const joinSec = $("join"), viewerSec = $("viewer");
const form = $("join-form"), pinInput = $("pin"), joinBtn = $("join-btn"), joinErr = $("join-error");
const stage = $("v-stage"), msg = $("v-msg");
const renderer = new SlideRenderer($("v-canvas"), stage);

let state = null; // { pin, unsub, presence, loaded, loading, last }

if (!configOk) {
  $("config-alert").hidden = false;
  joinBtn.disabled = true;
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
stage.addEventListener("dblclick", () => toggleFullscreen(stage));
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
    if (!snap.exists()) {
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

function enter(pin) {
  history.replaceState(null, "", `?pin=${pin}`);
  joinSec.hidden = true;
  viewerSec.hidden = false;
  document.body.classList.add("presenting");
  $("v-badge").className = "badge live";
  $("v-badge").textContent = "● AO VIVO";
  showMsg('<span class="spinner"></span>Conectando…');

  state = { pin, loaded: false, loading: false, last: null };

  // Presença (contador de visitantes do apresentador)
  const me = push(ref(db, `viewers/${pin}`));
  state.presence = me;
  set(me, serverTimestamp()).catch(() => {});
  onDisconnect(me).remove().catch(() => {});

  const current = state;
  state.unsub = onValue(ref(db, `sessions/${pin}`), async (snap) => {
    if (state !== current) return;
    if (!snap.exists()) return ended();

    const d = snap.val();
    current.last = d;
    $("v-title").innerHTML = escapeHtml(d.title || "Apresentação");
    document.title = `${d.title || "Apresentação"} · ao vivo`;

    if (!d.ready) {
      showMsg('<span class="spinner"></span>Aguardando o apresentador terminar de enviar o arquivo…');
      return;
    }

    if (!current.loaded && !current.loading) {
      current.loading = true;
      try {
        showMsg('<span class="spinner"></span>Baixando apresentação… 0%');
        const bytes = await downloadPdf(db, pin, d.chunks, (p) =>
          showMsg(`<span class="spinner"></span>Baixando apresentação… ${Math.round(p * 100)}%`));
        if (state !== current) return;
        await renderer.load(bytes);
        current.loaded = true;
        showMsg("");
      } catch (err) {
        console.error(err);
        showMsg("Erro ao carregar a apresentação. Atualize a página para tentar de novo.");
        return;
      } finally {
        current.loading = false;
      }
    }

    if (current.loaded) {
      const page = current.last.currentPage || 1;
      $("v-page").textContent = `Slide ${page} de ${current.last.numPages || renderer.numPages}`;
      renderer.show(page);
    }
  }, (err) => {
    console.error(err);
    showMsg("Conexão perdida com a apresentação.");
  });
}

function ended() {
  $("v-badge").className = "badge ended";
  $("v-badge").textContent = "ENCERRADA";
  $("v-page").textContent = "";
  renderer.unload();
  showMsg('A apresentação foi encerrada pelo apresentador.<br><button class="btn primary sm" id="v-back">Voltar</button>');
  $("v-back")?.addEventListener("click", leave);
}

function leave() {
  if (state) {
    state.unsub?.();
    if (state.presence) {
      onDisconnect(state.presence).cancel().catch(() => {});
      remove(state.presence).catch(() => {});
    }
  }
  state = null;
  renderer.unload();
  if (document.fullscreenElement) document.exitFullscreen?.();
  stage.classList.remove("fake-fs");
  document.body.classList.remove("presenting", "no-scroll");
  viewerSec.hidden = true;
  joinSec.hidden = false;
  document.title = "Apresentação ao vivo";
  history.replaceState(null, "", location.pathname);
  pinInput.value = "";
  pinInput.focus();
}
