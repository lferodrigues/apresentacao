// Anotações sobre os slides (lápis e marca-texto).
// Os pontos são guardados normalizados (0–1) em relação ao tamanho do slide,
// então o desenho fica no lugar certo em qualquer tela.
//
// Banco: annotations/{pin}/{página}/{idDoTraço} = { tool, color, w, pts }
//   tool  "pen" | "hl"      w  espessura relativa à largura do slide
//   pts   "x,y x,y …"       (4 casas decimais)

export const PEN_COLORS = ["#ff3b30", "#111111", "#ffffff", "#2f80ed", "#4cbb5f"];
export const HL_COLORS = ["#ffeb3b", "#76ff03", "#ff6ec7", "#4fc3f7", "#ffa726"];
export const WIDTH = { pen: 0.0035, hl: 0.022 };
export const HL_ALPHA = 0.35;
export const MAX_POINTS = 2500;

export const encodePts = (pts) => pts.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(" ");
export const decodePts = (s) =>
  String(s || "").split(" ").filter(Boolean).map((p) => p.split(",").map(Number));

/** Canvas transparente sobreposto ao slide. */
export class AnnotationLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.strokes = [];
    this.live = null;
    this.w = 0; this.h = 0; this.dpr = 1;
  }

  resize(w, h, dpr = 1) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.draw();
  }

  setStrokes(list) { this.strokes = list || []; this.draw(); }
  setLive(stroke) { this.live = stroke; this.draw(); }
  clear() { this.strokes = []; this.live = null; this.draw(); }

  /** Converte coordenadas da tela para 0–1 dentro do slide (null se fora). */
  toNorm(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = (clientX - r.left) / r.width, y = (clientY - r.top) / r.height;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  draw() {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.w) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const liveKey = this.live?.key;
    for (const s of this.strokes) if (s.key !== liveKey) this.drawStroke(s);
    if (this.live) this.drawStroke(this.live);
  }

  drawStroke(s) {
    const pts = s.points || decodePts(s.pts);
    if (!pts.length) return;
    const { ctx, w, h } = this;
    ctx.save();
    ctx.globalAlpha = s.tool === "hl" ? HL_ALPHA : 1;
    ctx.strokeStyle = s.color || "#ff3b30";
    ctx.lineWidth = Math.max(1, (s.w || WIDTH.pen) * w);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    if (pts.length === 1) {
      ctx.lineTo(pts[0][0] * w + 0.1, pts[0][1] * h);
    } else {
      // Curvas suaves passando pelos pontos médios
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * h, mx * w, my * h);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last[0] * w, last[1] * h);
    }
    ctx.stroke();
    ctx.restore();
  }
}

/** Lista os traços de um snapshot do Firebase, em ordem de criação. */
export function strokesFromSnap(snap) {
  const list = [];
  snap.forEach((c) => { list.push({ key: c.key, ...c.val() }); });
  return list;
}

/* ------------------------------------------------------------------ */
/*  Download do PDF                                                    */
/* ------------------------------------------------------------------ */

export function safeFileName(title) {
  const base = String(title || "apresentacao")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
  return (base || "apresentacao") + ".pdf";
}

export function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const hexToRgb = (hex) => {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};

/** Gera um novo PDF com as anotações desenhadas por cima de cada página. */
export async function buildAnnotatedPdf(bytes, annByPage) {
  const { PDFDocument, rgb, LineCapStyle, LineJoinStyle } =
    await import("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm");
  const doc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
  const pages = doc.getPages();

  for (const [num, strokes] of Object.entries(annByPage || {})) {
    const page = pages[Number(num) - 1];
    if (!page || !strokes) continue;
    const box = page.getCropBox();
    const { width, height } = box;

    for (const s of Object.values(strokes)) {
      const pts = decodePts(s.pts);
      if (!pts.length) continue;
      let d = `M ${pts[0][0] * width} ${pts[0][1] * height}`;
      if (pts.length === 1) d += ` L ${pts[0][0] * width + 0.1} ${pts[0][1] * height}`;
      for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0] * width} ${pts[i][1] * height}`;
      const [r, g, b] = hexToRgb(s.color);
      page.drawSvgPath(d, {
        x: box.x,
        y: box.y + height,
        borderColor: rgb(r, g, b),
        borderWidth: Math.max(0.5, (s.w || WIDTH.pen) * width),
        borderOpacity: s.tool === "hl" ? HL_ALPHA : 1,
        borderLineCap: LineCapStyle.Round,
        borderLineJoin: LineJoinStyle?.Round,
      });
    }
  }
  return doc.save();
}
