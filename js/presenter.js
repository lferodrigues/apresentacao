import {
  ref, get, set, update, onValue, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { db, configOk } from "./firebase.js";
import { SlideRenderer } from "./pdf-render.js";
import { initAccount } from "./account.js";
import {
  CHUNK_SIZE, MAX_FILE_MB, bytesToBase64, downloadPdf, shareLink,
  toggleFullscreen, onSwipe, toast, copyText, escapeHtml
} from "./common.js";

const $ = (id) => document.getElementById(id);
const sections = {
  login: $("login"), signup: $("signup"), forgot: $("forgot"),
  dashboard: $("dashboard"), present: $("present"),
};

const stage = $("p-stage"), pMsg = $("p-msg");
const renderer = new SlideRenderer($("p-canvas"), stage);

let user = null;
let listUnsub = null;
let current = null; // { pin, title, numPages, page, unsubs: [] }
let selectedFile = null;

function show(name) {
  for (const [k, el] of Object.entries(sections)) el.hidden = k !== name;
  document.body.classList.toggle("presenting", name === "present");
  window.scrollTo(0, 0);
}

if (!configOk) {
  $("config-alert").hidden = false;
  show("login");
  document.querySelectorAll("#login button").forEach((b) => (b.disabled = true));
} else {
  initAccount({
    show,
    onReady(u) {
      user = u;
      show("dashboard");
      watchMyList();
    },
    onSignedOut() {
      stopPresenting(false);
      listUnsub?.(); listUnsub = null;
      user = null;
    },
  });
}

/* ================= UPLOAD ================= */
const dz = $("dropzone"), fileInput = $("file");

function pickFile(file) {
  $("upload-error").textContent = "";
  if (!file) return;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    $("upload-error").textContent = "Escolha um arquivo PDF.";
    return;
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    $("upload-error").textContent = `O arquivo passa de ${MAX_FILE_MB} MB. Comprima o PDF e tente de novo.`;
    return;
  }
  selectedFile = file;
  $("dz-text").innerHTML = `<strong>${escapeHtml(file.name)}</strong> (${(file.size / 1048576).toFixed(1)} MB)`;
  dz.classList.add("has-file");
  if (!$("title").value.trim()) $("title").value = file.name.replace(/\.pdf$/i, "");
  $("upload-btn").disabled = false;
}

fileInput.addEventListener("change", () => pickFile(fileInput.files[0]));
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));

function setProgress(p, label) {
  const box = $("upload-progress");
  box.hidden = p === null;
  if (p === null) return;
  box.querySelector(".bar").style.width = `${Math.round(p * 100)}%`;
  box.querySelector("span").textContent = label;
}

async function generatePin() {
  for (let i = 0; i < 40; i++) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
    const pin = String(n).padStart(4, "0");
    const snap = await get(ref(db, `sessions/${pin}`));
    if (!snap.exists()) return pin;
  }
  throw new Error("Não há PINs livres no momento. Encerre apresentações antigas.");
}

$("upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedFile || !user) return;
  const btn = $("upload-btn");
  btn.disabled = true;
  $("upload-error").textContent = "";
  const title = $("title").value.trim() || selectedFile.name.replace(/\.pdf$/i, "");
  let pin = null;

  try {
    setProgress(0, "Lendo o PDF…");
    const bytes = new Uint8Array(await selectedFile.arrayBuffer());
    const numPages = await renderer.load(bytes); // valida o PDF

    pin = await generatePin();
    const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));

    await set(ref(db, `sessions/${pin}`), {
      owner: user.uid,
      title,
      numPages,
      currentPage: 1,
      chunks,
      ready: false,
      createdAt: serverTimestamp(),
    });

    for (let i = 0; i < chunks; i++) {
      const part = bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      await set(ref(db, `files/${pin}/c${i}`), bytesToBase64(part));
      setProgress((i + 1) / chunks, `Enviando… ${Math.round(((i + 1) / chunks) * 100)}%`);
    }

    await update(ref(db), {
      [`sessions/${pin}/ready`]: true,
      [`users/${user.uid}/sessions/${pin}`]: { title, numPages, createdAt: serverTimestamp() },
    });

    setProgress(null);
    resetUploadForm();
    toast(`Apresentação criada! PIN ${pin}`, "ok");
    startPresenting(pin, title, numPages, 1, true);
  } catch (err) {
    console.error(err);
    setProgress(null);
    $("upload-error").textContent = "Falha no envio: " + (err?.message || err);
    if (pin) cleanup(pin).catch(() => {});
    renderer.unload();
  } finally {
    btn.disabled = !selectedFile;
  }
});

function resetUploadForm() {
  selectedFile = null;
  fileInput.value = "";
  $("title").value = "";
  $("dz-text").innerHTML = "<strong>Clique para escolher</strong> ou arraste o PDF aqui";
  dz.classList.remove("has-file");
  $("upload-btn").disabled = true;
}

/* ================= LISTA ================= */
function watchMyList() {
  listUnsub?.();
  listUnsub = onValue(ref(db, `users/${user.uid}/sessions`), (snap) => {
    const ul = $("my-list");
    const items = [];
    snap.forEach((c) => { items.push({ pin: c.key, ...c.val() }); });
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (!items.length) {
      ul.innerHTML = '<li class="muted">Nenhuma apresentação ativa. Envie um PDF acima.</li>';
      return;
    }
    ul.innerHTML = items.map((s) => `
      <li>
        <div class="s-pin">${s.pin}</div>
        <div class="s-info">
          <strong>${escapeHtml(s.title)}</strong>
          <span class="muted small">${s.numPages || "?"} slides · ${s.createdAt ? new Date(s.createdAt).toLocaleString("pt-BR") : ""}</span>
        </div>
        <div class="s-actions">
          <button class="btn primary sm" data-act="open" data-pin="${s.pin}">Apresentar</button>
          <button class="btn ghost sm" data-act="copy" data-pin="${s.pin}">Link</button>
          <button class="btn danger sm" data-act="end" data-pin="${s.pin}">Encerrar</button>
        </div>
      </li>`).join("");
  });
}

$("my-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const pin = b.dataset.pin;
  if (b.dataset.act === "copy") return copyText(shareLink(pin));
  if (b.dataset.act === "end") return endSession(pin);
  if (b.dataset.act === "open") return reopen(pin, b);
});

async function reopen(pin, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  try {
    const snap = await get(ref(db, `sessions/${pin}`));
    if (!snap.exists()) {
      await update(ref(db), { [`users/${user.uid}/sessions/${pin}`]: null });
      toast("Essa apresentação não existe mais.", "err");
      return;
    }
    const d = snap.val();
    btn.textContent = "Baixando…";
    const bytes = await downloadPdf(db, pin, d.chunks, (p) => (btn.textContent = `${Math.round(p * 100)}%`));
    await renderer.load(bytes);
    startPresenting(pin, d.title, d.numPages, d.currentPage || 1, false);
  } catch (err) {
    console.error(err);
    toast("Erro ao abrir: " + (err?.message || err), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ================= APRESENTAÇÃO ================= */
function startPresenting(pin, title, numPages, page, _fresh) {
  stopPresenting(false);
  current = { pin, title, numPages, page, unsubs: [] };
  $("p-pin").textContent = pin;
  $("p-title").textContent = title;
  document.title = `PIN ${pin} · ${title}`;
  pMsg.hidden = true;
  show("present");
  renderer.show(page);
  updateIndicator();

  // Contador de visitantes
  current.unsubs.push(onValue(ref(db, `viewers/${pin}`), (s) => {
    $("p-viewers").textContent = s.size;
  }));

  // Mantém sincronizado se o slide mudar em outro dispositivo do apresentador
  current.unsubs.push(onValue(ref(db, `sessions/${pin}`), (s) => {
    if (!current || current.pin !== pin) return;
    if (!s.exists()) {
      toast("A apresentação foi encerrada.", "err");
      stopPresenting();
      return;
    }
    const p = s.val().currentPage || 1;
    if (p !== current.page) {
      current.page = p;
      renderer.show(p);
      updateIndicator();
    }
  }));
}

function stopPresenting(goDashboard = true) {
  if (current) current.unsubs.forEach((u) => u());
  current = null;
  renderer.unload();
  if (document.fullscreenElement) document.exitFullscreen?.();
  stage.classList.remove("fake-fs");
  document.body.classList.remove("no-scroll");
  document.title = "Painel do apresentador";
  if (goDashboard && user) show("dashboard");
}

function updateIndicator() {
  if (!current) return;
  const txt = `${current.page} / ${current.numPages}`;
  $("p-page").textContent = txt;
  $("fs-page").textContent = txt;
  $("p-prev").disabled = $("p-first").disabled = $("fs-prev").disabled = current.page <= 1;
  $("p-next").disabled = $("p-last").disabled = $("fs-next").disabled = current.page >= current.numPages;
}

function goTo(n) {
  if (!current) return;
  n = Math.min(Math.max(1, n), current.numPages);
  if (n === current.page) return;
  current.page = n;
  renderer.show(n);
  updateIndicator();
  update(ref(db, `sessions/${current.pin}`), { currentPage: n })
    .catch((err) => { console.error(err); toast("Falha ao sincronizar o slide.", "err"); });
}

const next = () => current && goTo(current.page + 1);
const prev = () => current && goTo(current.page - 1);

$("p-next").addEventListener("click", next);
$("p-prev").addEventListener("click", prev);
$("fs-next").addEventListener("click", (e) => { e.stopPropagation(); next(); });
$("fs-prev").addEventListener("click", (e) => { e.stopPropagation(); prev(); });
$("p-first").addEventListener("click", () => current && goTo(1));
$("p-last").addEventListener("click", () => current && goTo(current.numPages));
$("p-fullscreen").addEventListener("click", () => toggleFullscreen(stage));
$("p-copy").addEventListener("click", () => current && copyText(shareLink(current.pin)));
$("p-back").addEventListener("click", () => stopPresenting());
$("p-end").addEventListener("click", () => current && endSession(current.pin));

// Clique/toque: metade esquerda volta, metade direita avança
stage.addEventListener("click", (e) => {
  if (!current || e.target.closest(".fs-controls")) return;
  const r = stage.getBoundingClientRect();
  (e.clientX - r.left) < r.width * 0.35 ? prev() : next();
});
onSwipe(stage, next, prev);

document.addEventListener("keydown", (e) => {
  if (!current || sections.present.hidden) return;
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  switch (e.key) {
    case "ArrowRight": case "ArrowDown": case "PageDown": case " ": case "Enter":
      e.preventDefault(); next(); break;
    case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace":
      e.preventDefault(); prev(); break;
    case "Home": e.preventDefault(); goTo(1); break;
    case "End": e.preventDefault(); goTo(current.numPages); break;
    case "f": case "F": toggleFullscreen(stage); break;
  }
});

/* ================= ENCERRAR ================= */
async function cleanup(pin) {
  // Uma única atualização remove tudo de forma atômica
  await update(ref(db), {
    [`viewers/${pin}`]: null,
    [`files/${pin}`]: null,
    [`sessions/${pin}`]: null,
    [`users/${user.uid}/sessions/${pin}`]: null,
  });
}

async function endSession(pin) {
  if (!confirm(`Encerrar a apresentação do PIN ${pin}? Os visitantes deixarão de ver os slides e o arquivo será apagado.`)) return;
  try {
    const wasCurrent = current?.pin === pin;
    if (wasCurrent) stopPresenting();
    await cleanup(pin);
    toast("Apresentação encerrada.", "ok");
  } catch (err) {
    console.error(err);
    toast("Erro ao encerrar: " + (err?.message || err), "err");
  }
}
