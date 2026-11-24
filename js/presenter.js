import {
  ref, get, set, update, remove, push, onValue, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { db, configOk } from "./firebase.js";
import { SlideRenderer } from "./pdf-render.js";
import { initAccount } from "./account.js";
import { ScreenBroadcaster, canShareScreen, canUseCamera } from "./screen.js";
import {
  AnnotationLayer, PEN_COLORS, HL_COLORS, WIDTH, MAX_POINTS, encodePts, strokesFromSnap,
  downloadBytes, safeFileName
} from "./annotations.js";
import {
  CHUNK_SIZE, MAX_FILE_MB, bytesToBase64, downloadPdf, shareLink, downloadLink,
  toggleFullscreen, onSwipe, toast, copyText, escapeHtml,
  trackServerTime, serverNow, formatDateTime, timeLeft, renderDownloadBox, modal, DOWNLOAD_HOURS,
  sessionPdfPath, libraryPdfPath, libraryExpiry, formatDate, formatSize, LIBRARY_MONTHS
} from "./common.js";

const $ = (id) => document.getElementById(id);
const sections = {
  login: $("login"), signup: $("signup"), forgot: $("forgot"),
  dashboard: $("dashboard"), files: $("files"), present: $("present"), screen: $("screen"),
};

const stage = $("p-stage"), pMsg = $("p-msg");
const renderer = new SlideRenderer($("p-canvas"), stage);
const ann = new AnnotationLayer($("p-ann"));
renderer.onLayout = (w, h, dpr) => ann.resize(w, h, dpr);

let user = null;
let listUnsub = null;
let current = null; // { pin, title, numPages, page, unsubs: [] }
let selectedFile = null;

function show(name) {
  for (const [k, el] of Object.entries(sections)) el.hidden = k !== name;
  document.body.classList.toggle("presenting", name === "present" || name === "screen");
  window.scrollTo(0, 0);
}

if (!configOk) {
  $("config-alert").hidden = false;
  show("login");
  document.querySelectorAll("#login button").forEach((b) => (b.disabled = true));
} else {
  trackServerTime(db);
  initAccount({
    show,
    onReady(u) {
      user = u;
      show("dashboard");
      watchMyList();
      watchLibrary();
    },
    onSignedOut() {
      stopPresenting(false);
      stopScreen(false);
      listUnsub?.(); listUnsub = null;
      libUnsub?.(); libUnsub = null;
      library = [];
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
    const d = snap.val();
    if (d.ended && d.expiresAt && d.expiresAt < serverNow()) {
      try { await purge(pin); return pin; } catch (err) { console.warn(err); }
    }
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

  let fileId = null, uploaded = false;

  try {
    setProgress(0, "Lendo o PDF…");
    const bytes = new Uint8Array(await selectedFile.arrayBuffer());
    const numPages = await renderer.load(bytes); // valida o PDF
    const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));

    // 1) Salva o PDF em "Meus arquivos" (fica guardado por 6 meses)
    fileId = push(ref(db, `library/${user.uid}`)).key;
    await set(ref(db, `library/${user.uid}/${fileId}`), {
      title,
      name: selectedFile.name.slice(0, 255),
      size: bytes.length,
      numPages,
      chunks,
      ready: false,
      createdAt: serverTimestamp(),
      expiresAt: libraryExpiry(),
    });
    for (let i = 0; i < chunks; i++) {
      const part = bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      await set(ref(db, `${libraryPdfPath(user.uid, fileId)}/c${i}`), bytesToBase64(part));
      setProgress((i + 1) / chunks, `Enviando… ${Math.round(((i + 1) / chunks) * 100)}%`);
    }
    await update(ref(db, `library/${user.uid}/${fileId}`), { ready: true });
    uploaded = true;

    // 2) Cria a apresentação (PIN) apontando para o arquivo salvo
    setProgress(1, "Gerando o PIN…");
    pin = await createPdfSession(fileId, title, numPages, chunks);

    setProgress(null);
    resetUploadForm();
    toast(`Apresentação criada! PIN ${pin}`, "ok");
    startPresenting(pin, title, numPages, 1, true);
  } catch (err) {
    console.error(err);
    setProgress(null);
    $("upload-error").textContent = "Falha no envio: " + (err?.message || err);
    if (pin) cleanup(pin).catch(() => {});
    else if (fileId && !uploaded) removeLibraryFile(fileId).catch(() => {});
    if (uploaded) $("upload-error").textContent += " O PDF ficou salvo em Meus arquivos; tente apresentar por lá.";
    renderer.unload();
  } finally {
    btn.disabled = !selectedFile;
  }
});

/** Cria uma sessão (PIN) que usa um PDF já salvo em "Meus arquivos". */
async function createPdfSession(fileId, title, numPages, chunks) {
  const pin = await generatePin();
  await set(ref(db, `sessions/${pin}`), {
    owner: user.uid,
    title,
    numPages,
    currentPage: 1,
    chunks,
    file: fileId,
    ready: true,
    createdAt: serverTimestamp(),
  });
  await update(ref(db), {
    [`library/${user.uid}/${fileId}/pin`]: pin,
    [`users/${user.uid}/sessions/${pin}`]: { title, numPages, createdAt: serverTimestamp() },
  });
  return pin;
}

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

    // Downloads vencidos: apaga do banco automaticamente
    const now = serverNow();
    for (const s of items.filter((s) => s.ended && s.expiresAt && s.expiresAt < now)) {
      purgeMine(s.pin).catch((err) => console.warn(err));
    }
    const list = items.filter((s) => !(s.ended && s.expiresAt && s.expiresAt < now));

    if (!list.length) {
      ul.innerHTML = '<li class="muted">Nenhuma apresentação ativa. Envie um PDF ou espelhe sua tela acima.</li>';
      return;
    }
    ul.innerHTML = list.map((s) => `
      <li class="${s.ended ? "is-ended" : ""} ${s.mode === "screen" ? "is-screen" : ""}">
        <div class="s-pin">${s.pin}</div>
        <div class="s-info">
          <strong>${escapeHtml(s.title)}</strong>
          <span class="muted small">${s.ended
            ? `<span class="tag">Encerrada · download até ${formatDateTime(s.expiresAt)}</span>`
            : s.mode === "screen"
              ? `<span class="tag green">🖥 Espelhamento de tela</span> ${s.createdAt ? new Date(s.createdAt).toLocaleString("pt-BR") : ""}`
              : `${s.numPages || "?"} slides · ${s.createdAt ? new Date(s.createdAt).toLocaleString("pt-BR") : ""}`}</span>
        </div>
        <div class="s-actions">
          ${s.ended
            ? `<button class="btn primary sm" data-act="qr" data-pin="${s.pin}">QR e link de download</button>
               <button class="btn ghost sm" data-act="open" data-pin="${s.pin}">Reabrir</button>
               <button class="btn danger sm" data-act="delete" data-pin="${s.pin}">Excluir</button>`
            : `<button class="btn primary sm" data-act="open" data-pin="${s.pin}">${s.mode === "screen" ? "Transmitir" : "Apresentar"}</button>
               <button class="btn ghost sm" data-act="copy" data-pin="${s.pin}">Link</button>
               <button class="btn danger sm" data-act="end" data-pin="${s.pin}">Encerrar</button>`}
        </div>
      </li>`).join("");
  });
}

$("my-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const pin = b.dataset.pin;
  const act = b.dataset.act;
  if (act === "copy") return copyText(shareLink(pin));
  if (act === "end") return endSession(pin);
  if (act === "delete") return deleteSession(pin);
  if (act === "open") return reopen(pin, b);
  if (act === "qr") return showQrModal(pin);
});

async function showQrModal(pin) {
  const d = (await get(ref(db, `sessions/${pin}`))).val();
  if (!d) return toast("Essa apresentação não existe mais.", "err");
  const box = document.createElement("div");
  renderDownloadBox(box, pin, { title: d.title, expiresAt: d.expiresAt, compact: true });
  modal({ title: `Download · PIN ${pin}`, content: box, buttons: [{ label: "Fechar", cls: "ghost" }] });
}

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
    if (d.mode === "screen") { startScreen(pin, d.title); return; }
    btn.textContent = "Baixando…";
    const bytes = await downloadPdf(db, sessionPdfPath(pin, d), d.chunks, (p) => (btn.textContent = `${Math.round(p * 100)}%`));
    await renderer.load(bytes);
    if (d.ended) {
      await update(ref(db), {
        [`sessions/${pin}/ended`]: null,
        [`sessions/${pin}/endedAt`]: null,
        [`sessions/${pin}/expiresAt`]: null,
        [`users/${user.uid}/sessions/${pin}/ended`]: null,
        [`users/${user.uid}/sessions/${pin}/expiresAt`]: null,
      });
    }
    startPresenting(pin, d.title, d.numPages, d.currentPage || 1);
  } catch (err) {
    console.error(err);
    toast("Erro ao abrir: " + (err?.message || err), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ================= MEUS ARQUIVOS (salvos por 6 meses) ================= */
let libUnsub = null;
let library = [];   // [{ id, title, name, size, numPages, chunks, createdAt, expiresAt, pin }]

function watchLibrary() {
  libUnsub?.();
  libUnsub = onValue(ref(db, `library/${user.uid}`), (snap) => {
    const items = [];
    snap.forEach((c) => { items.push({ id: c.key, ...c.val() }); });
    const now = serverNow();

    // Arquivos com mais de 6 meses (ou envios que não terminaram há mais de 1 dia) são apagados
    for (const f of items) {
      const stale = f.expiresAt < now || (!f.ready && f.createdAt && f.createdAt < now - 86400000);
      if (stale) removeLibraryFile(f.id).catch((err) => console.warn(err));
    }
    library = items
      .filter((f) => f.ready && f.expiresAt >= now)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const pill = $("files-count");
    pill.hidden = !library.length;
    pill.textContent = library.length;
    renderLibrary();
  }, (err) => {
    console.error(err);
    $("files-list").innerHTML = '<li class="muted">Não foi possível carregar seus arquivos. Confira se as regras do banco foram atualizadas.</li>';
  });
}

function renderLibrary() {
  const ul = $("files-list");
  const q = $("files-search").value.trim().toLowerCase();
  const list = q ? library.filter((f) => `${f.title} ${f.name || ""}`.toLowerCase().includes(q)) : library;
  const total = library.reduce((s, f) => s + (f.size || 0), 0);
  $("files-usage").textContent = library.length
    ? `${library.length} arquivo${library.length > 1 ? "s" : ""} · ${formatSize(total)} usados`
    : "";

  if (!library.length) {
    ul.innerHTML = `<li class="muted">Nenhum arquivo salvo. Os PDFs que você enviar aparecem aqui por ${LIBRARY_MONTHS} meses.</li>`;
    return;
  }
  if (!list.length) {
    ul.innerHTML = '<li class="muted">Nenhum arquivo encontrado com essa busca.</li>';
    return;
  }
  const soon = serverNow() + 7 * 86400000;
  ul.innerHTML = list.map((f) => `
    <li>
      <div class="f-icon" aria-hidden="true">📄</div>
      <div class="s-info">
        <strong>${escapeHtml(f.title)}</strong>
        <span class="muted small">${f.numPages} slide${f.numPages > 1 ? "s" : ""} · ${f.size ? formatSize(f.size) : "?"} · enviado em ${f.createdAt ? formatDate(f.createdAt) : "?"}</span>
        <span class="small"><span class="tag ${f.expiresAt < soon ? "warn" : ""}">Salvo até ${formatDate(f.expiresAt)}</span></span>
      </div>
      <div class="s-actions">
        <button class="btn primary sm" data-fact="present" data-id="${f.id}">Apresentar</button>
        <button class="btn ghost sm" data-fact="download" data-id="${f.id}">⬇ Baixar</button>
        <button class="btn danger sm" data-fact="delete" data-id="${f.id}">Excluir</button>
      </div>
    </li>`).join("");
}

$("open-files").addEventListener("click", () => { show("files"); renderLibrary(); $("files-search").focus(); });
$("files-back").addEventListener("click", () => show("dashboard"));
$("files-search").addEventListener("input", renderLibrary);

$("files-list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-fact]");
  if (!b) return;
  const f = library.find((x) => x.id === b.dataset.id);
  if (!f) return;
  if (b.dataset.fact === "present") return presentFromLibrary(f, b);
  if (b.dataset.fact === "download") return downloadFromLibrary(f, b);
  if (b.dataset.fact === "delete") return deleteLibraryFile(f);
});

async function fetchLibraryBytes(f, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  try {
    return await downloadPdf(db, libraryPdfPath(user.uid, f.id), f.chunks,
      (p) => (btn.textContent = `${Math.round(p * 100)}%`));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function downloadFromLibrary(f, btn) {
  try {
    const bytes = await fetchLibraryBytes(f, btn);
    downloadBytes(bytes, f.name && /\.pdf$/i.test(f.name) ? f.name : safeFileName(f.title));
  } catch (err) {
    console.error(err);
    toast("Erro ao baixar: " + (err?.message || err), "err");
  }
}

async function presentFromLibrary(f, btn) {
  try {
    // O arquivo já está em uma apresentação? Abre a mesma ou avisa antes de trocar o PIN.
    const prev = f.pin ? (await get(ref(db, `sessions/${f.pin}`))).val() : null;
    const mine = prev && prev.owner === user.uid && prev.file === f.id;
    if (mine && !prev.ended) {
      const bytes = await fetchLibraryBytes(f, btn);
      await renderer.load(bytes);
      toast(`Este arquivo já estava aberto no PIN ${f.pin}.`);
      startPresenting(f.pin, prev.title, prev.numPages, prev.currentPage || 1);
      return;
    }
    if (mine && prev.ended && prev.expiresAt > serverNow()) {
      const ok = await modal({
        title: "Apresentar de novo?",
        html: `<p class="muted">O download do PIN <strong>${f.pin}</strong> está liberado até ${formatDateTime(prev.expiresAt)}. Ao apresentar de novo, um PIN novo é criado e esse link de download para de funcionar.</p>`,
        buttons: [{ label: "Apresentar com PIN novo", value: true, cls: "primary" }, { label: "Cancelar", cls: "ghost" }],
      });
      if (!ok) return;
      await purge(f.pin, user.uid);
    }
    const bytes = await fetchLibraryBytes(f, btn);
    await renderer.load(bytes);
    btn.disabled = true;
    const pin = await createPdfSession(f.id, f.title, f.numPages, f.chunks);
    toast(`Apresentação criada! PIN ${pin}`, "ok");
    startPresenting(pin, f.title, f.numPages, 1);
  } catch (err) {
    console.error(err);
    renderer.unload();
    toast("Erro ao apresentar: " + (err?.message || err), "err");
  } finally {
    btn.disabled = false;
  }
}

/** Apaga o arquivo salvo e, se ele estiver em uma apresentação, encerra essa apresentação. */
async function removeLibraryFile(fileId) {
  const upd = {
    [`library/${user.uid}/${fileId}`]: null,
    [libraryPdfPath(user.uid, fileId)]: null,
  };
  const pin = (await get(ref(db, `library/${user.uid}/${fileId}/pin`))).val();
  if (pin) {
    const d = (await get(ref(db, `sessions/${pin}`))).val();
    if (d && d.owner === user.uid && d.file === fileId) {
      if (current?.pin === pin) stopPresenting(false);
      await purge(pin, user.uid);
    }
  }
  await update(ref(db), upd);
}

async function deleteLibraryFile(f) {
  const ok = await modal({
    title: "Excluir este arquivo?",
    html: `<p><strong>${escapeHtml(f.title)}</strong></p>
      <p class="muted">O PDF será apagado da plataforma para sempre. Se ele estiver sendo apresentado ou com o download liberado, o PIN também será encerrado.</p>`,
    buttons: [{ label: "Excluir arquivo", value: true, cls: "danger" }, { label: "Cancelar", cls: "ghost" }],
  });
  if (!ok) return;
  try {
    await removeLibraryFile(f.id);
    toast("Arquivo excluído.", "ok");
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + (err?.message || err), "err");
  }
}

/* ================= APRESENTAÇÃO ================= */
function startPresenting(pin, title, numPages, page) {
  stopPresenting(false, true);
  stopScreen(false);
  current = { pin, title, numPages, page, unsubs: [], annUnsub: null, ended: false };
  $("p-pin").textContent = pin;
  $("p-title").textContent = title;
  document.title = `PIN ${pin} · ${title}`;
  pMsg.hidden = true;
  show("present");
  renderer.show(page);
  updateIndicator();
  watchAnnotations();

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
    const d = s.val();
    if (d.ended) { showEnded(d); return; }
    if (current.ended) hideEnded();
    const p = d.currentPage || 1;
    if (p !== current.page) {
      current.page = p;
      renderer.show(p);
      updateIndicator();
      watchAnnotations();
    }
  }));
}

/**
 * Fecha a apresentação atual.
 * keepDoc = true mantém o PDF carregado (usado ao abrir uma nova apresentação,
 * logo depois de carregar o arquivo — antes isso apagava o PDF e o palco
 * do apresentador ficava preto).
 */
function stopPresenting(goDashboard = true, keepDoc = false) {
  if (current) {
    current.unsubs.forEach((u) => u());
    current.annUnsub?.();
  }
  current = null;
  drawing = null;
  hideEnded();
  ann.clear();
  setTool("nav");
  if (!keepDoc) renderer.unload();
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
  if (!current || current.ended) return;
  n = Math.min(Math.max(1, n), current.numPages);
  if (n === current.page) return;
  finishStroke();
  current.page = n;
  renderer.show(n);
  updateIndicator();
  watchAnnotations();
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

// Clique/toque: metade esquerda volta, metade direita avança (só no modo navegar)
stage.addEventListener("click", (e) => {
  if (!current || current.ended || tool !== "nav") return;
  if (e.target.closest(".fs-controls, .ann-toolbar, .stage-msg")) return;
  const r = stage.getBoundingClientRect();
  (e.clientX - r.left) < r.width * 0.35 ? prev() : next();
});
onSwipe(stage, () => tool === "nav" && next(), () => tool === "nav" && prev());

document.addEventListener("keydown", (e) => {
  if (!current || sections.present.hidden || current.ended) return;
  if (document.querySelector(".modal-backdrop, dialog[open]")) return;
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case "ArrowRight": case "ArrowDown": case "PageDown": case " ": case "Enter":
      e.preventDefault(); next(); break;
    case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace":
      e.preventDefault(); prev(); break;
    case "Home": e.preventDefault(); goTo(1); break;
    case "End": e.preventDefault(); goTo(current.numPages); break;
    case "f": case "F": toggleFullscreen(stage); break;
    case "p": case "P": setTool("pen"); break;
    case "h": case "H": setTool("hl"); break;
    case "Escape": setTool("nav"); break;
  }
});

/* ================= ANOTAÇÕES ================= */
let tool = "nav";
const colors = { pen: PEN_COLORS[0], hl: HL_COLORS[0] };
let drawing = null;      // traço em andamento { key, tool, color, w, points }
let syncTimer = null;

function setTool(t) {
  tool = t;
  document.querySelectorAll("#ann-toolbar [data-tool]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === t));
  stage.classList.toggle("drawing", t !== "nav");
  stage.classList.toggle("clickable", t === "nav");
  renderSwatches();
}

function renderSwatches() {
  const box = $("ann-colors");
  const list = tool === "hl" ? HL_COLORS : PEN_COLORS;
  const active = tool === "hl" ? colors.hl : colors.pen;
  box.hidden = tool === "nav";
  box.innerHTML = list.map((c) => `
    <button class="swatch ${tool === "hl" ? "hl" : ""} ${c === active ? "active" : ""}" type="button"
      data-color="${c}" style="--sw:${c}" aria-label="Cor ${c}" title="${tool === "hl" ? "Marca-texto" : "Lápis"} ${c}"></button>`).join("");
}

$("ann-toolbar").addEventListener("click", (e) => {
  e.stopPropagation();
  const t = e.target.closest("[data-tool]");
  if (t) return setTool(t.dataset.tool);
  const sw = e.target.closest("[data-color]");
  if (sw) {
    colors[tool === "hl" ? "hl" : "pen"] = sw.dataset.color;
    renderSwatches();
  }
});
$("ann-toolbar").addEventListener("pointerdown", (e) => e.stopPropagation());
$("ann-undo").addEventListener("click", undo);
$("ann-clear").addEventListener("click", clearPage);
setTool("nav");

function watchAnnotations() {
  if (!current) return;
  current.annUnsub?.();
  const { pin, page } = current;
  ann.setStrokes([]);
  current.annUnsub = onValue(ref(db, `annotations/${pin}/${page}`), (snap) => {
    if (!current || current.pin !== pin || current.page !== page) return;
    current.strokes = strokesFromSnap(snap);
    ann.setStrokes(current.strokes);
  });
}

function annPath() { return `annotations/${current.pin}/${current.page}`; }

function syncStroke(s) {
  if (!current) return;
  set(ref(db, `${annPath()}/${s.key}`), {
    tool: s.tool, color: s.color, w: s.w, pts: encodePts(s.points),
  }).catch((err) => { console.error(err); toast("Falha ao salvar a anotação.", "err"); });
}

stage.addEventListener("pointerdown", (e) => {
  if (!current || current.ended || tool === "nav" || e.button > 0) return;
  if (e.target.closest(".ann-toolbar, .fs-controls")) return;
  const p = ann.toNorm(e.clientX, e.clientY);
  if (!p) return;
  e.preventDefault();
  stage.setPointerCapture?.(e.pointerId);
  drawing = {
    key: push(ref(db, annPath())).key,
    tool, color: colors[tool], w: WIDTH[tool], points: [p],
  };
  ann.setLive(drawing);
});

stage.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events) {
    const p = ann.toNorm(ev.clientX, ev.clientY);
    const last = drawing.points[drawing.points.length - 1];
    if (p && Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.0015) drawing.points.push(p);
  }
  ann.setLive(drawing);
  // Envia o traço parcial a cada 120 ms para os visitantes verem ao vivo
  if (!syncTimer) {
    syncTimer = setTimeout(() => {
      syncTimer = null;
      if (drawing) syncStroke(drawing);
    }, 120);
  }
  // Traços muito longos são divididos em partes
  if (drawing.points.length >= MAX_POINTS) {
    const lastPt = drawing.points[drawing.points.length - 1];
    const { tool: t, color, w } = drawing;
    finishStroke();
    drawing = { key: push(ref(db, annPath())).key, tool: t, color, w, points: [lastPt] };
  }
});

function finishStroke() {
  clearTimeout(syncTimer); syncTimer = null;
  if (!drawing) return;
  const s = drawing;
  drawing = null;
  // mantém o traço na tela até o banco confirmar
  current?.strokes?.push({ key: s.key, tool: s.tool, color: s.color, w: s.w, points: s.points });
  ann.setLive(null);
  if (current?.strokes) ann.setStrokes(current.strokes);
  syncStroke(s);
}
["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) =>
  stage.addEventListener(ev, finishStroke));

function undo() {
  if (!current) return;
  const list = current.strokes || [];
  const last = list[list.length - 1];
  if (!last) return toast("Nada para desfazer neste slide.");
  list.pop();
  ann.setStrokes(list);
  remove(ref(db, `${annPath()}/${last.key}`)).catch((err) => console.error(err));
}

function clearPage() {
  if (!current || !(current.strokes || []).length) return toast("Este slide não tem anotações.");
  if (!confirm("Apagar todas as anotações deste slide?")) return;
  current.strokes = [];
  ann.setStrokes([]);
  remove(ref(db, annPath())).catch((err) => console.error(err));
}

/* ================= FIM: TELA DE DOWNLOAD ================= */
function showEnded(d) {
  if (!current) return;
  finishStroke();
  setTool("nav");
  current.ended = true;
  stage.classList.add("ended");
  sections.present.classList.add("is-ended");
  pMsg.hidden = false;
  renderDownloadBox(pMsg, current.pin, {
    title: d.title,
    expiresAt: d.expiresAt,
    backLabel: "Voltar ao painel",
    onBack: () => stopPresenting(),
  });
  $("p-viewers").textContent = "0";
}

function hideEnded() {
  if (current) current.ended = false;
  stage.classList.remove("ended");
  sections.present.classList.remove("is-ended");
  pMsg.hidden = true;
  pMsg.innerHTML = "";
}

/* ================= ENCERRAR ================= */
/** Apaga tudo de uma apresentação (arquivo, anotações, visitantes e sessão). */
async function purge(pin, ownerUid) {
  const upd = {
    [`viewers/${pin}`]: null,
    [`annotations/${pin}`]: null,
    [`rtc/${pin}`]: null,
    [`files/${pin}`]: null,
    [`sessions/${pin}`]: null,
  };
  if (ownerUid) upd[`users/${ownerUid}/sessions/${pin}`] = null;
  await update(ref(db), upd);
}

async function cleanup(pin) {
  await purge(pin, user.uid);
}

/** Remove uma apresentação minha (ou só o item da lista, se o PIN já for de outra pessoa). */
async function purgeMine(pin) {
  const d = (await get(ref(db, `sessions/${pin}`))).val();
  if (d && d.owner === user.uid) return cleanup(pin);
  await update(ref(db), { [`users/${user.uid}/sessions/${pin}`]: null });
}

function askEnd(pin) {
  const dlg = $("end-dialog");
  $("end-pin").textContent = pin;
  return new Promise((resolve) => {
    dlg.returnValue = "cancel";
    dlg.addEventListener("close", () => resolve(dlg.returnValue || "cancel"), { once: true });
    dlg.showModal();
  });
}

async function endSession(pin) {
  const mode = (await get(ref(db, `sessions/${pin}/mode`)).catch(() => null))?.val();
  if (mode === "screen") return endScreen(pin);
  const choice = await askEnd(pin);
  if (choice === "cancel") return;

  try {
    const wasCurrent = current?.pin === pin;
    if (choice === "finish") {
      finishStroke();
      const expiresAt = serverNow() + DOWNLOAD_HOURS * 3600 * 1000;
      await update(ref(db), {
        [`sessions/${pin}/ended`]: true,
        [`sessions/${pin}/endedAt`]: serverTimestamp(),
        [`sessions/${pin}/expiresAt`]: expiresAt,
        [`users/${user.uid}/sessions/${pin}/ended`]: true,
        [`users/${user.uid}/sessions/${pin}/expiresAt`]: expiresAt,
      });
      // Se estiver apresentando, a própria tela vira a tela de download (com QR Code)
      if (!wasCurrent) {
        toast(`Encerrada. Download liberado até ${formatDateTime(expiresAt)}.`, "ok");
        showQrModal(pin);
      }
    } else {
      if (wasCurrent) stopPresenting();
      await cleanup(pin);
      toast("Apresentação encerrada. O PDF continua em Meus arquivos.", "ok");
    }
  } catch (err) {
    console.error(err);
    toast("Erro ao encerrar: " + (err?.message || err), "err");
  }
}

async function deleteSession(pin) {
  const ok = await modal({
    title: `Excluir a apresentação ${pin}?`,
    html: "<p class=\"muted\">O PIN, as anotações e o link de download serão apagados agora. Ninguém mais poderá baixar por esse link. O PDF continua em <b>Meus arquivos</b>.</p>",
    buttons: [{ label: "Excluir agora", value: true, cls: "danger" }, { label: "Cancelar", cls: "ghost" }],
  });
  if (!ok) return;
  try {
    if (current?.pin === pin) stopPresenting();
    await cleanup(pin);
    toast("Apresentação excluída.", "ok");
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + (err?.message || err), "err");
  }
}

/* ================= ESPELHAMENTO DE TELA ================= */
let bc = null;            // ScreenBroadcaster ativo
let screenPin = null;
let screenUnsubs = [];

$("screen-btn").addEventListener("click", createScreenSession);

async function createScreenSession() {
  if (!user) return;
  if (!canShareScreen() && !canUseCamera()) {
    $("upload-error").textContent = "Este navegador não permite transmitir tela nem câmera.";
    return;
  }
  const btn = $("screen-btn");
  btn.disabled = true;
  $("upload-error").textContent = "";
  try {
    const title = $("title").value.trim() || "Tela ao vivo";
    const pin = await generatePin();
    await set(ref(db, `sessions/${pin}`), {
      owner: user.uid, title, mode: "screen", ready: true, live: false, createdAt: serverTimestamp(),
    });
    await set(ref(db, `users/${user.uid}/sessions/${pin}`), { title, mode: "screen", createdAt: serverTimestamp() });
    $("title").value = "";
    toast(`Transmissão criada! PIN ${pin}`, "ok");
    startScreen(pin, title);
  } catch (err) {
    console.error(err);
    $("upload-error").textContent = "Não foi possível criar a transmissão: " + (err?.message || err);
  } finally {
    btn.disabled = false;
  }
}

function startScreen(pin, title) {
  stopPresenting(false);
  stopScreen(false);
  screenPin = pin;
  $("s-pin").textContent = pin;
  $("s-title").textContent = title;
  $("s-viewers").textContent = "0";
  document.title = `PIN ${pin} · ${title}`;
  show("screen");

  bc = new ScreenBroadcaster(db, pin, {
    onViewers: (n) => { $("s-viewers").textContent = n; },
    onSource: (src) => updateScreenUi(src),
  });
  bc.listen();
  updateScreenUi(null);

  // Se a página fechar ou a internet cair, avisa que parou
  onDisconnect(ref(db, `sessions/${pin}/live`)).set(false).catch(() => {});

  screenUnsubs.push(onValue(ref(db, `sessions/${pin}`), (s) => {
    if (screenPin === pin && !s.exists()) {
      toast("A transmissão foi encerrada.", "err");
      stopScreen();
    }
  }));
}

function updateScreenUi(src) {
  if (!bc || !screenPin) return;
  const live = !!src;
  const badge = $("s-live");
  badge.className = live ? "badge live" : "badge ended";
  badge.textContent = live ? "● AO VIVO" : "PARADO";

  const video = $("s-video");
  video.srcObject = live ? bc.stream : null;
  $("s-stage").classList.toggle("is-video", live);

  const msg = $("s-msg");
  if (live) {
    msg.innerHTML = "";
  } else {
    msg.innerHTML = `<div class="screen-start">
      <div class="big-ico">🖥</div>
      <h2>Pronto para transmitir</h2>
      <p class="muted">${canShareScreen()
        ? "Clique em <b>Compartilhar tela</b> e escolha a tela inteira, uma janela ou uma aba. Para enviar o som de um vídeo, escolha uma <b>aba</b> e marque “compartilhar áudio”."
        : "Este aparelho não permite espelhar a tela pelo navegador (celulares e tablets). Você pode transmitir a <b>câmera</b> e o <b>microfone</b>."}</p>
      <p class="muted small">Quem estiver com o PIN <b>${screenPin}</b> vê tudo ao vivo.</p>
    </div>`;
  }

  $("s-share").hidden = !canShareScreen();
  $("s-share").textContent = src === "screen" ? "🖥 Trocar tela" : "🖥 Compartilhar tela";
  $("s-share").classList.toggle("primary", src !== "camera");
  $("s-camera").hidden = !canUseCamera();
  $("s-camera").textContent = src === "camera" ? "📷 Câmera ligada" : "📷 Câmera";
  $("s-camera").classList.toggle("primary", !canShareScreen() || src === "camera");
  $("s-flip").hidden = src !== "camera";
  $("s-mode").hidden = src !== "screen";
  $("s-stop").hidden = !live;

  update(ref(db, `sessions/${screenPin}`), { live }).catch(() => {});
}

async function startShare(kind) {
  if (!bc) return;
  try {
    if (kind === "screen") await bc.shareScreen();
    else await bc.shareCamera();
  } catch (err) {
    console.warn(err);
    if (err?.name === "NotAllowedError") toast("Permissão negada ou compartilhamento cancelado.", "err");
    else if (err?.name === "NotFoundError") toast("Nenhuma câmera encontrada.", "err");
    else toast("Não foi possível iniciar: " + (err?.message || err), "err");
  }
}

$("s-share").addEventListener("click", () => startShare("screen"));
$("s-camera").addEventListener("click", () => startShare("camera"));
$("s-flip").addEventListener("click", () => bc?.flipCamera().catch(() => toast("Não foi possível trocar a câmera.", "err")));
$("s-stop").addEventListener("click", () => bc?.stopSharing());
$("s-mode").addEventListener("click", () => {
  if (!bc) return;
  const motion = bc.mode !== "motion";
  bc.setMode(motion ? "motion" : "detail");
  $("s-mode").textContent = motion ? "🎬 Modo vídeo" : "🔤 Modo texto";
  toast(motion ? "Modo vídeo: mais fluido, ideal para vídeos e animações." : "Modo texto: máxima nitidez, ideal para slides e código.");
});
$("s-mic").addEventListener("click", async () => {
  if (!bc) return;
  const b = $("s-mic");
  try {
    await bc.setMic(!bc.micOn);
    b.setAttribute("aria-pressed", String(bc.micOn));
    b.classList.toggle("primary", bc.micOn);
    b.textContent = bc.micOn ? "🎙 Microfone ligado" : "🎙 Microfone desligado";
  } catch (err) {
    console.warn(err);
    toast("Não foi possível usar o microfone. Verifique a permissão do navegador.", "err");
  }
});
$("s-copy").addEventListener("click", () => screenPin && copyText(shareLink(screenPin)));
$("s-back").addEventListener("click", () => stopScreen());
$("s-end").addEventListener("click", () => screenPin && endScreen(screenPin));

function resetMicButton() {
  const b = $("s-mic");
  b.setAttribute("aria-pressed", "false");
  b.classList.remove("primary");
  b.textContent = "🎙 Microfone desligado";
  $("s-mode").textContent = "🔤 Modo texto";
}

function stopScreen(goDashboard = true) {
  const pin = screenPin;
  screenUnsubs.forEach((u) => u());
  screenUnsubs = [];
  bc?.destroy();
  bc = null;
  screenPin = null;
  $("s-video").srcObject = null;
  $("s-stage").classList.remove("is-video");
  resetMicButton();
  if (pin) {
    update(ref(db, `sessions/${pin}`), { live: false }).catch(() => {});
    onDisconnect(ref(db, `sessions/${pin}/live`)).cancel().catch(() => {});
  }
  if (goDashboard && user && !sections.screen.hidden) {
    document.title = "Painel do apresentador";
    show("dashboard");
  }
}

async function endScreen(pin) {
  const ok = await modal({
    title: `Encerrar a transmissão ${pin}?`,
    html: "<p class=\"muted\">A transmissão para e o PIN deixa de funcionar para todos.</p>",
    buttons: [{ label: "Encerrar transmissão", value: true, cls: "danger" }, { label: "Cancelar", cls: "ghost" }],
  });
  if (!ok) return;
  try {
    if (screenPin === pin) stopScreen();
    await cleanup(pin);
    toast("Transmissão encerrada.", "ok");
  } catch (err) {
    console.error(err);
    toast("Erro ao encerrar: " + (err?.message || err), "err");
  }
}
