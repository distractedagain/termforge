// Literal highlighting is bounded to visible rows and 512 decorations.
// No regular expressions or remote output are evaluated as code.
export function attachKeywordHighlighting(term, getSettings) {
  let timer = null;
  let disposed = false;
  const decorations = [];
  const clear = () => { while (decorations.length) { const { decoration, marker } = decorations.pop(); decoration?.dispose(); marker?.dispose(); } };
  const columnAt = (line, offset) => {
    let characters = 0;
    for (let column = 0; column < term.cols; column += 1) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;
      const text = cell.getChars() || ' ';
      if (characters + text.length > offset) return column;
      characters += text.length;
      if (characters === offset) return column + cell.getWidth();
    }
    return term.cols;
  };
  const render = () => {
    timer = null; clear(); if (disposed) return;
    const settings = getSettings();
    if (!settings.keywordHighlightEnabled) return;
    const rules = (settings.keywords || []).slice(0, 32).filter((rule) => typeof rule.text === 'string' && rule.text.length && rule.text.length <= 128);
    const buffer = term.buffer.active;
    const first = buffer.viewportY;
    const last = Math.min(buffer.length, first + term.rows);
    for (let lineIndex = first; lineIndex < last && decorations.length < 512; lineIndex += 1) {
      const line = buffer.getLine(lineIndex); if (!line) continue;
      const text = line.translateToString(true);
      for (const rule of rules) {
        const haystack = rule.caseSensitive ? text : text.toLowerCase();
        const needle = rule.caseSensitive ? rule.text : rule.text.toLowerCase();
        let offset = 0;
        while (offset <= text.length && decorations.length < 512) {
          const match = haystack.indexOf(needle, offset); if (match < 0) break;
          const x = columnAt(line, match); const end = columnAt(line, match + rule.text.length);
          offset = match + Math.max(1, needle.length);
          if (end <= x || x >= term.cols) continue;
          const marker = term.registerMarker(lineIndex - buffer.baseY - buffer.cursorY);
          if (!marker) continue;
          const decoration = term.registerDecoration({ marker, x, width: Math.min(term.cols - x, end - x), layer: 'top', foregroundColor: rule.foreground, backgroundColor: rule.background });
          if (decoration) decorations.push({ decoration, marker }); else marker.dispose();
        }
      }
    }
  };
  const refresh = () => { if (!disposed && timer === null) timer = window.setTimeout(render, 80); };
  const listeners = [term.onWriteParsed(refresh), term.onScroll(refresh), term.onResize(refresh)];
  refresh();
  return { refresh, dispose() { disposed = true; if (timer !== null) clearTimeout(timer); clear(); for (const listener of listeners) listener.dispose(); } };
}
