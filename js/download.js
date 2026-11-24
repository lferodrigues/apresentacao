import { ref, get, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { db, configOk } from "./firebase.js";
import { buildAnnotatedPdf, downloadBytes, safeFileName } from "./annotations.js";
import {
  isValidPin, downloadPdf, sessionPdfPath, downloadLink, shareLink, copyText,
  trackServerTime, serverNow, formatDateTime, timeLeft, toast
} from "./common.js";
import { qrSvg } from "./vendor/qrcode.js";

const $ = (id) => document.getElementById(id);
const pin = new URLSearchParams(location.search).get("pin");
let session = null;
let pdfBytes = null;
let busy = false;
let tick = null;

function view(name) {
  for (const id of ["dl-loading", "dl-ready", "dl-live", "dl-gone"]) $(id).hidden = id !== name;
}

function gone(text) {
  if (text) $("dl-gone-text").textContent = text;
  view("dl-gone");
  clearInterval(tick);
}

if (!configOk) {
  $("config-alert").hidden = false;
  gone("O sistema ainda não foi configurado.");
} else if (!isValidPin(pin)) {
  gone("Este link de download é inválido. Confira se ele foi copiado por completo.");
} else {
  trackServerTime(db);
  onValue(ref(db, `sessions/${pin}`), (snap) => {
    session = snap.val();
    render();
  }, (err) => {
    console.error(err);
    gone("Não foi possível acessar o arquivo. O prazo pode ter terminado.");
  });
}

function render() {
  const d = session;
  if (!d) return gone();
  if (!d.ended) {
    $("dl-watch").href = shareLink(pin);
    view("dl-live");
    return;
  }
  if (!d.expiresAt || d.expiresAt <= serverNow()) return gone();

  document.title = `Baixar · ${d.title}`;
  $("dl-title").textContent = d.title || "Apresentação";
  $("dl-pages").textContent = `${d.numPages} slide${d.numPages > 1 ? "s" : ""}`;
  $("dl-until").textContent = formatDateTime(d.expiresAt);
  $("dl-left").textContent = timeLeft(d.expiresAt);

  const link = downloadLink(pin);
  $("dl-link").textContent = link;
  $("dl-qr").innerHTML = qrSvg(link, { margin: 2 });
  view("dl-ready");

  clearInterval(tick);
  tick = setInterval(() => {
    if (session.expiresAt <= serverNow()) return gone();
    $("dl-left").textContent = timeLeft(session.expiresAt);
  }, 30000);
}

function progress(p, label) {
  const box = $("dl-progress");
  box.hidden = p === null;
  if (p === null) return;
  box.querySelector(".bar").style.width = `${Math.round(p * 100)}%`;
  box.querySelector("span").textContent = label;
}

async function getBytes() {
  if (pdfBytes) return pdfBytes;
  progress(0, "Baixando… 0%");
  pdfBytes = await downloadPdf(db, sessionPdfPath(pin, session), session.chunks, (p) => progress(p, `Baixando… ${Math.round(p * 100)}%`));
  return pdfBytes;
}

async function doDownload(withNotes) {
  if (busy || !session) return;
  busy = true;
  $("dl-error").textContent = "";
  document.querySelectorAll(".dl-option").forEach((b) => (b.disabled = true));
  try {
    const bytes = await getBytes();
    let out = bytes, name = safeFileName(session.title);
    if (withNotes) {
      progress(1, "Aplicando as anotações…");
      const annSnap = await get(ref(db, `annotations/${pin}`));
      const ann = annSnap.val();
      if (ann && Object.keys(ann).length) {
        try {
          out = await buildAnnotatedPdf(bytes, ann);
          name = name.replace(/\.pdf$/, "-anotado.pdf");
        } catch (err) {
          console.error(err);
          toast("Não foi possível aplicar as anotações. Baixando o original.", "err");
        }
      } else {
        toast("Esta apresentação não tem anotações. Baixando o original.");
      }
    }
    downloadBytes(out, name);
    progress(1, "Pronto! Verifique seus downloads.");
    setTimeout(() => progress(null), 4000);
  } catch (err) {
    console.error(err);
    progress(null);
    $("dl-error").textContent = err?.code === "PERMISSION_DENIED"
      ? "O prazo de download terminou."
      : "Falha ao baixar: " + (err?.message || err);
  } finally {
    busy = false;
    document.querySelectorAll(".dl-option").forEach((b) => (b.disabled = false));
  }
}

$("dl-annotated").addEventListener("click", () => doDownload(true));
$("dl-original").addEventListener("click", () => doDownload(false));
$("dl-copy").addEventListener("click", () => copyText(downloadLink(pin)));
