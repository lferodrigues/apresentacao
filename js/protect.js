/*
 * Proteção contra cópia e inspeção casual.
 * Bloqueia: botão direito, F12, Ctrl+Shift+I/J/C/K, Ctrl+U (código-fonte),
 * Ctrl+S (salvar), Ctrl+P (imprimir), atalhos equivalentes no Mac,
 * arrastar imagens e selecionar texto fora dos campos de formulário.
 *
 * Observação: nenhuma página web consegue impedir 100% o acesso às
 * ferramentas do desenvolvedor (ex.: pelo menu do navegador). Isto é uma
 * barreira contra o uso comum, não uma proteção absoluta.
 */
(function () {
  "use strict";

  var isField = function (el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  };

  var block = function (e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  };

  // Botão direito
  document.addEventListener("contextmenu", block, true);

  // Atalhos do teclado
  document.addEventListener("keydown", function (e) {
    var code = e.code || "";
    var key = (e.key || "").toLowerCase();
    var ctrl = e.ctrlKey || e.metaKey;

    if (key === "f12" || code === "F12") return block(e);

    // Ctrl+Shift+I / J / C / K  (Windows/Linux) e Cmd+Option+I / J / C / U (Mac)
    if (ctrl && (e.shiftKey || e.altKey) &&
        ["KeyI", "KeyJ", "KeyC", "KeyK", "KeyU"].indexOf(code) !== -1) return block(e);

    // Ctrl+U (código-fonte), Ctrl+S (salvar), Ctrl+P (imprimir)
    if (ctrl && !e.shiftKey && ["KeyU", "KeyS", "KeyP"].indexOf(code) !== -1) return block(e);

    // Ctrl+A / Ctrl+C fora dos campos de texto
    if (ctrl && !isField(e.target) && (code === "KeyA" || code === "KeyC")) return block(e);
  }, true);

  // Arrastar imagens/slides
  document.addEventListener("dragstart", function (e) {
    if (!isField(e.target) && e.target.closest && !e.target.closest(".dropzone")) block(e);
  }, true);

  // Seleção de texto fora dos campos
  document.addEventListener("selectstart", function (e) {
    if (!isField(e.target)) block(e);
  }, true);

  // Copiar fora dos campos
  document.addEventListener("copy", function (e) {
    if (!isField(document.activeElement)) block(e);
  }, true);

  // Impressão: esconde o conteúdo
  var style = document.createElement("style");
  style.textContent =
    "@media print{body{display:none!important}}" +
    "body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}" +
    "input,textarea{-webkit-user-select:text;user-select:text}" +
    "img,canvas{-webkit-user-drag:none;user-drag:none}";
  (document.head || document.documentElement).appendChild(style);
})();
