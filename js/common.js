import { ref, get, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { qrSvg } from "./vendor/qrcode.js";

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

/** Por quanto tempo os PDFs enviados ficam salvos em "Meus arquivos". */
export const LIBRARY_MONTHS = 6;

/** Data de expiração: hoje + 6 meses (hora do servidor). */
export function libraryExpiry(from = serverNow()) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + LIBRARY_MONTHS);
  return d.getTime();
}

/** Opções de tempo para manter o PDF em "Meus arquivos" (escolhidas ao encerrar). */
export const RETENTION_OPTIONS = [
  { id: "3h", label: "3 horas", hours: 3 },
  { id: "1d", label: "1 dia", hours: 24 },
  { id: "1w", label: "1 semana", hours: 24 * 7 },
  { id: "1m", label: "1 mês", months: 1 },
  { id: "6m", label: "6 meses", months: LIBRARY_MONTHS },
];

/** Data de expiração para uma das opções acima, contada a partir de agora (hora do servidor). */
export function retentionExpiry(opt, from = serverNow()) {
  if (opt.hours) return from + opt.hours * 3600 * 1000;
  const d = new Date(from);
  d.setMonth(d.getMonth() + opt.months);
  return d.getTime();
}

/** Caminho no banco onde ficam os pedaços do PDF de uma sessão. */
export const sessionPdfPath = (pin, d) =>
  d?.file && d?.owner ? `libraryFiles/${d.owner}/${d.file}` : `files/${pin}`;

/** Caminho dos pedaços de um arquivo salvo em "Meus arquivos". */
export const libraryPdfPath = (uid, fileId) => `libraryFiles/${uid}/${fileId}`;

/**
 * Baixa os pedaços do PDF e devolve um Uint8Array.
 * `src` é um PIN (arquivos antigos em files/{pin}) ou um caminho completo no banco.
 */
export async function downloadPdf(db, src, chunks, onProgress) {
  const base = isValidPin(src) ? `files/${src}` : src;
  let done = 0;
  const parts = await Promise.all(
    Array.from({ length: chunks }, async (_, i) => {
      const snap = await get(ref(db, `${base}/c${i}`));
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

/** Link da página de download do PDF (válido por 24 h após o fim). */
export const downloadLink = (pin) => new URL(`./download.html?pin=${pin}`, location.href).href;

export const DOWNLOAD_HOURS = 24;

/* ---------- Hora do servidor (evita erro com relógio do aparelho) ---------- */
let serverOffset = 0;
export function trackServerTime(db) {
  onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });
}
export const serverNow = () => Date.now() + serverOffset;

export const formatDate = (ms) =>
  new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

export const formatSize = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const formatDateTime = (ms) =>
  new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function timeLeft(ms) {
  const diff = Math.max(0, ms - serverNow());
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}min` : `${m} min`;
}

/**
 * Monta o bloco de download (QR Code + link + botões) dentro de `el`.
 * opts: { title, expiresAt, backLabel, onBack, compact }
 */
export function renderDownloadBox(el, pin, opts = {}) {
  const link = downloadLink(pin);
  el.innerHTML = `
    <div class="dl-box ${opts.compact ? "compact" : ""}">
      <span class="badge ok-badge">APRESENTAÇÃO ENCERRADA</span>
      <h2>${escapeHtml(opts.title || "Baixe a apresentação")}</h2>
      <p class="muted">Aponte a câmera para o QR Code ou use o link para baixar o PDF.
        ${opts.expiresAt ? `<br>Disponível até <strong>${formatDateTime(opts.expiresAt)}</strong> (${timeLeft(opts.expiresAt)}).` : ""}</p>
      <div class="qr">${qrSvg(link, { margin: 2 })}</div>
      <div class="dl-link"><code>${escapeHtml(link)}</code></div>
      <div class="dl-actions">
        <a class="btn primary" href="${link}">⬇ Baixar PDF</a>
        <button class="btn ghost" type="button" data-copy>🔗 Copiar link</button>
        ${opts.onBack ? `<button class="btn ghost" type="button" data-back>${escapeHtml(opts.backLabel || "Voltar")}</button>` : ""}
      </div>
    </div>`;
  el.querySelector("[data-copy]").addEventListener("click", () => copyText(link));
  if (opts.onBack) el.querySelector("[data-back]").addEventListener("click", opts.onBack);
}

/* ---------- Janela de escolha (modal) ---------- */
export function modal({ title, html = "", buttons = [], content }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `
      <div class="modal card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <h2>${escapeHtml(title)}</h2>
        <div class="modal-body">${html}</div>
        <div class="modal-actions"></div>
      </div>`;
    if (content) back.querySelector(".modal-body").appendChild(content);
    const actions = back.querySelector(".modal-actions");
    const close = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn ${b.cls || "ghost"}`;
      btn.textContent = b.label;
      btn.addEventListener("click", () => close(b.value ?? null));
      actions.appendChild(btn);
    }
    back.addEventListener("click", (e) => { if (e.target === back) close(null); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    actions.querySelector("button")?.focus();
  });
}

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
