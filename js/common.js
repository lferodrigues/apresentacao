import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// Tamanho de cada pedaço do PDF gravado no Realtime Database (bytes brutos).
// ~700 KB viram ~950 KB em base64, bem abaixo do limite de 10 MB por escrita.
export const CHUNK_SIZE = 700 * 1024;
export const MAX_FILE_MB = 30;

export const isValidPin = (p) => /^\d{4}$/.test(String(p || ""));

export function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Baixa os pedaços do PDF de files/{pin} e devolve um Uint8Array. */
export async function downloadPdf(db, pin, chunks, onProgress) {
  let done = 0;
  const parts = await Promise.all(
    Array.from({ length: chunks }, async (_, i) => {
      const snap = await get(ref(db, `files/${pin}/c${i}`));
      if (!snap.exists()) throw new Error("Arquivo incompleto no servidor.");
      const bytes = base64ToBytes(snap.val());
      done++;
      onProgress?.(done / chunks);
      return bytes;
    })
  );
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Link público para visitantes entrarem direto com o PIN. */
export const shareLink = (pin) => new URL(`./assistir.html?pin=${pin}`, location.href).href;

/* ---------- Tela cheia (com alternativa para iPhone) ---------- */
export function isFullscreen(el) {
  return document.fullscreenElement === el ||
    document.webkitFullscreenElement === el ||
    el.classList.contains("fake-fs");
}

export function toggleFullscreen(el) {
  if (isFullscreen(el)) {
    if (el.classList.contains("fake-fs")) {
      el.classList.remove("fake-fs");
      document.body.classList.remove("no-scroll");
      window.dispatchEvent(new Event("resize"));
    } else if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    return;
  }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) {
    req.call(el).catch?.(() => fakeFs(el));
  } else {
    fakeFs(el);
  }
}

function fakeFs(el) {
  el.classList.add("fake-fs");
  document.body.classList.add("no-scroll");
  window.dispatchEvent(new Event("resize"));
}

/* ---------- Gestos de deslizar ---------- */
export function onSwipe(el, onLeft, onRight) {
  let x0 = null, y0 = null;
  el.addEventListener("touchstart", (e) => {
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      dx < 0 ? onLeft() : onRight();
    }
  }, { passive: true });
}

/* ---------- Aviso rápido (toast) ---------- */
let toastTimer;
export function toast(msg, type = "") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 3000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copiado!", "ok");
  } catch {
    prompt("Copie o texto:", text);
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function authErrorMessage(err) {
  const map = {
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/user-not-found": "Usuário não encontrado.",
    "auth/invalid-email": "E-mail inválido.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos.",
    "auth/network-request-failed": "Sem conexão com a internet.",
    "auth/user-disabled": "Este usuário foi desativado.",
    "auth/missing-password": "Digite a senha.",
    "auth/email-already-in-use": "Já existe uma conta com este e-mail. Entre ou use \"Esqueci minha senha\".",
    "auth/weak-password": "Senha fraca: use pelo menos 6 caracteres.",
    "auth/popup-blocked": "O navegador bloqueou a janela de login. Permita pop-ups para este site e tente de novo.",
    "auth/account-exists-with-different-credential": "Este e-mail já está ligado a outra forma de login. Entre pelo método que você usou antes.",
    "auth/operation-not-allowed": "Este método de login ainda não foi ativado no Firebase.",
    "auth/unauthorized-domain": "Este domínio não está autorizado no Firebase Authentication.",
    "auth/missing-email": "Digite seu e-mail.",
  };
  return map[err?.code] || "Não foi possível entrar. " + (err?.message || "");
}
