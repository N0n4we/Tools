const blank = (fg = "#d8dee9", bg = "#282c34") => ({ text: " ", fg, bg, bold: false, underline: false });
const color = (value, foreground) => {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : foreground ? "d8dee9" : "282c34";
  return `\x1b[${foreground ? 38 : 48};2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}m`;
};
const width = character => /[\p{Mark}\u200d\ufe0e\ufe0f]/u.test(character) ? 0
  : /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6\p{Extended_Pictographic}]/u.test(character) ? 2 : 1;

// Translate vim.wasm's GUI draw events into terminal cells. No browser or
// terminal emulator dependency is needed on the debug client.
export class VimScreen {
  constructor(output, onMetrics = () => {}) {
    this.output = output;
    this.onMetrics = onMetrics;
    this.cellWidth = 7;
    this.cellHeight = 14;
    this.fg = "#d8dee9";
    this.bg = "#282c34";
    this.active = false;
    this.resize(output.columns ?? 80, output.rows ?? 24);
  }

  resize(columns, rows) {
    this.columns = Math.max(2, columns);
    this.rows = Math.max(2, rows);
    this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.columns }, () => blank(this.fg, this.bg)));
    this.dirty = new Set(Array.from({ length: this.rows }, (_, index) => index));
    if (this.active) this.output.write("\x1b[2J");
  }

  start() {
    this.active = true;
    this.output.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J");
  }

  close() {
    clearImmediate(this.pending);
    this.active = false;
    this.output.write("\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l");
  }

  rectangle(x, y, w, h, change) {
    const left = Math.max(0, Math.floor(x / this.cellWidth));
    const right = Math.min(this.columns, Math.ceil((x + w) / this.cellWidth));
    const top = Math.max(0, Math.floor(y / this.cellHeight));
    const bottom = Math.min(this.rows, Math.ceil((y + h) / this.cellHeight));
    for (let row = top; row < bottom; row++) {
      for (let column = left; column < right; column++) this.cells[row][column] = change(this.cells[row][column]);
      this.dirty.add(row);
    }
  }

  draw([method, args]) {
    if (!this.active) return;
    switch (method) {
      case "setColorFG": this.fg = args[0]; break;
      case "setColorBG": this.bg = args[0]; break;
      case "drawRect": {
        const [x, y, w, h, fill, filled] = args;
        if (filled) this.rectangle(x, y, w, h, () => blank(this.fg, fill));
        break;
      }
      case "invertRect": this.rectangle(...args, cell => ({ ...cell, fg: cell.bg, bg: cell.fg })); break;
      case "drawText": {
        const [text, , lineHeight, cellWidth, x, y, bold, underline, undercurl] = args;
        if (cellWidth !== this.cellWidth || lineHeight !== this.cellHeight) {
          this.cellWidth = cellWidth;
          this.cellHeight = lineHeight;
          this.onMetrics();
        }
        const row = Math.floor(y / lineHeight);
        let column = Math.floor(x / cellWidth);
        if (row < 0 || row >= this.rows) break;
        for (const character of text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")) {
          const size = width(character);
          if (!size) {
            if (column > 0 && column <= this.columns) {
              let previous = column - 1;
              if (this.cells[row][previous].text === "" && previous > 0) previous--;
              this.cells[row][previous] = { ...this.cells[row][previous], text: this.cells[row][previous].text + character };
            }
            continue;
          }
          if (column >= 0 && column < this.columns) {
            this.cells[row][column] = { ...this.cells[row][column], text: character, fg: this.fg, bold, underline: underline || undercurl };
            if (size === 2 && column + 1 < this.columns) this.cells[row][column + 1] = { ...this.cells[row][column], text: "" };
          }
          column += size;
        }
        this.dirty.add(row);
        break;
      }
      case "imageScroll": {
        const [x, sy, dy, w, h] = args;
        const copy = this.cells.map(row => row.map(cell => ({ ...cell })));
        this.rectangle(x, dy, w, h, cell => cell);
        const distance = Math.round((sy - dy) / this.cellHeight);
        for (const row of this.dirty) {
          if (row < Math.floor(dy / this.cellHeight) || row >= Math.ceil((dy + h) / this.cellHeight)) continue;
          for (let column = Math.max(0, Math.floor(x / this.cellWidth)); column < Math.min(this.columns, Math.ceil((x + w) / this.cellWidth)); column++) {
            this.cells[row][column] = copy[row + distance]?.[column] ?? blank(this.fg, this.bg);
          }
        }
        break;
      }
    }
    if (!this.pending) this.pending = setImmediate(() => { this.pending = undefined; this.flush(); });
  }

  flush() {
    if (!this.active) return;
    let output = "";
    for (const row of this.dirty) {
      output += `\x1b[${row + 1};1H\x1b[0m\x1b[2K`;
      let previous = "";
      for (const cell of this.cells[row]) {
        const style = `${cell.fg}:${cell.bg}:${cell.bold}:${cell.underline}`;
        if (style !== previous) {
          output += `\x1b[0m${color(cell.fg, true)}${color(cell.bg, false)}${cell.bold ? "\x1b[1m" : ""}${cell.underline ? "\x1b[4m" : ""}`;
          previous = style;
        }
        output += cell.text;
      }
    }
    this.dirty.clear();
    if (output) this.output.write(output);
  }
}
