// Converte uma imagem em foto de perfil quadrada no formato WebP (data URL).
// A foto é recortada no centro e reduzida para AVATAR_SIZE px, ficando com
// poucos KB — leve o bastante para ser salva direto no Realtime Database.

export const AVATAR_SIZE = 320;
const QUALITY = 0.85;

async function loadImage(blob) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch {}
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Não foi possível ler esta imagem.")); };
    img.src = url;
  });
}

/** Recebe um File/Blob de imagem e devolve "data:image/webp;base64,…". */
export async function imageToWebp(blob, size = AVATAR_SIZE) {
  if (!blob || !/^image\//.test(blob.type || "image/")) throw new Error("Escolha um arquivo de imagem.");
  if (blob.size > 15 * 1024 * 1024) throw new Error("A imagem passa de 15 MB.");

  const img = await loadImage(blob);
  const w = img.width, h = img.height;
  const side = Math.min(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
  img.close?.();

  const dataUrl = canvas.toDataURL("image/webp", QUALITY);
  if (!dataUrl.startsWith("data:image/webp")) {
    throw new Error("Seu navegador não consegue gerar imagens WebP. Atualize o navegador ou use Chrome, Edge ou Firefox.");
  }
  return dataUrl;
}

/** Baixa a foto de uma URL (ex.: foto do Google) e converte para WebP. */
export async function urlToWebp(url) {
  const big = url.replace(/=s\d+(-c)?$/, "=s400-c"); // pede versão maior da foto do Google
  const res = await fetch(big, { mode: "cors" });
  if (!res.ok) throw new Error("Falha ao baixar a foto.");
  return imageToWebp(await res.blob());
}

/** Preenche um elemento .avatar com a foto ou com as iniciais. */
export function renderAvatar(el, photo, name = "") {
  el.innerHTML = "";
  if (photo) {
    const img = document.createElement("img");
    img.src = photo;
    img.alt = "";
    el.appendChild(img);
  } else {
    const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
    el.textContent = initials || "?";
  }
}
