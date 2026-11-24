import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";

/**
 * Desenha uma página do PDF ajustada ao tamanho do palco (stage),
 * com nitidez para telas de alta densidade, sem piscar entre slides.
 */
export class SlideRenderer {
  constructor(canvas, stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.doc = null;
    this.page = 1;
    this.token = 0;
    this.task = null;

    let t;
    const onResize = () => { clearTimeout(t); t = setTimeout(() => this.render(), 120); };
    new ResizeObserver(onResize).observe(stage);
    window.addEventListener("resize", onResize);
  }

  get numPages() { return this.doc?.numPages || 0; }

  async load(bytes) {
    await this.unload();
    // pdf.js transfere o buffer para o worker; passamos uma cópia
    this.doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    return this.doc.numPages;
  }

  async unload() {
    this.token++;
    try { this.task?.cancel(); } catch {}
    if (this.doc) { try { await this.doc.destroy(); } catch {} }
    this.doc = null;
    const ctx = this.canvas.getContext("2d");
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.style.width = this.canvas.style.height = "0px";
  }

  show(n) {
    if (!this.doc) { this.page = n; return; }
    this.page = Math.min(Math.max(1, n), this.doc.numPages);
    return this.render();
  }

  async render() {
    if (!this.doc) return;
    const token = ++this.token;
    try { this.task?.cancel(); } catch {}

    const page = await this.doc.getPage(this.page);
    if (token !== this.token) return;

    const base = page.getViewport({ scale: 1 });
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    const fit = Math.min(w / base.width, h / base.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = page.getViewport({ scale: fit * dpr });

    const off = document.createElement("canvas");
    off.width = Math.floor(vp.width);
    off.height = Math.floor(vp.height);
    this.task = page.render({ canvasContext: off.getContext("2d"), viewport: vp });
    try {
      await this.task.promise;
    } catch (e) {
      if (e?.name === "RenderingCancelledException") return;
      throw e;
    }
    if (token !== this.token) return;

    const c = this.canvas;
    c.width = off.width;
    c.height = off.height;
    c.style.width = Math.floor(base.width * fit) + "px";
    c.style.height = Math.floor(base.height * fit) + "px";
    c.getContext("2d").drawImage(off, 0, 0);
  }
}
