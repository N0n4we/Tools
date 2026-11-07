import { resolve } from "node:path/posix";
import { emitKeypressEvents } from "node:readline";
import { Worker } from "node:worker_threads";
import { VimScreen } from "./vim-screen.mjs";

const special = {
  escape: ["Escape", 27], return: ["Enter", 13], enter: ["Enter", 13],
  backspace: ["Backspace", 8], delete: ["Delete", 46], tab: ["Tab", 9],
  up: ["ArrowUp", 38], down: ["ArrowDown", 40], left: ["ArrowLeft", 37], right: ["ArrowRight", 39],
  home: ["Home", 36], end: ["End", 35], pageup: ["PageUp", 33], pagedown: ["PageDown", 34],
};

export function vimArguments(args, cwd, readOnly) {
  const files = [];
  let line;
  let literal = false;
  for (const arg of args) {
    if (!literal && arg === "--") { literal = true; continue; }
    if (!literal && arg === "-R") { readOnly = true; continue; }
    if (!literal && /^\+\d*$/.test(arg)) { line = arg; continue; }
    if (!literal && arg.startsWith("-")) throw new Error(`vim: unsupported option ${arg}; use vim [-R] [+LINE] [--] [FILE ...]`);
    if (!arg || arg.length > 512 || /[\x00-\x1f\x7f]/.test(arg)) throw new Error("vim: invalid virtual filename");
    files.push(resolve(cwd, arg));
  }
  return ["-N", "-u", "NONE", "-i", "NONE", "-n", "--cmd", "set nomodeline noswapfile nobackup nowritebackup noundofile viminfo=", "-c", "syntax enable", "-c", "colorscheme onedark", ...(readOnly ? ["-R"] : []), ...(line ? [line] : []), "--", ...files];
}

export async function runVim(editor, { request, signal, input = process.stdin, output = process.stdout, onReady } = {}) {
  const cmdArgs = vimArguments(editor.args, editor.cwd, editor.readOnly);
  signal?.throwIfAborted();
  const worker = new Worker(new URL("vim.worker.mjs", import.meta.url), {
    workerData: { cwd: editor.cwd, readOnly: editor.readOnly, maxFileBytes: 256 * 1024 },
  });
  const shared = new Int32Array(new SharedArrayBuffer(1024));
  const queue = [];
  let busy = false;
  let settled = false;
  let resolveExit;
  let rejectExit;
  const exit = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  const fail = error => { if (!settled) { settled = true; rejectExit(error); } };
  const pump = () => {
    if (busy || !queue.length || settled) return;
    const [status, values] = queue[0];
    let offset = 1;
    for (const value of values) {
      if (typeof value === "string") {
        shared[offset++] = value.length;
        for (let index = 0; index < value.length; index++) shared[offset++] = value.charCodeAt(index);
      } else shared[offset++] = Number(value);
    }
    busy = true;
    Atomics.store(shared, 0, status);
    Atomics.notify(shared, 0, 1);
  };
  const event = (status, ...values) => { queue.push([status, values]); pump(); };
  const key = (name, code, modifiers = {}) => event(1, code, !!modifiers.ctrl, !!modifiers.shift, !!modifiers.alt, !!modifiers.meta, name);
  const characterKey = (character, modifiers = {}) => {
    if (character.codePointAt(0) < 128) key(character, character.toUpperCase().charCodeAt(0), modifiers);
    else {
      // This Vim port only appends one byte per key event. Unknown DOM key
      // names preserve keyCode, so feed UTF-8 bytes rather than truncate Unicode.
      for (const byte of new TextEncoder().encode(character)) key("UTF8", byte);
    }
  };
  const resize = () => event(2, screen.columns * screen.cellWidth, screen.rows * screen.cellHeight);
  const screen = new VimScreen(output, resize);
  const keypress = (text, pressed = {}) => {
    // Node folds ESC followed by a character in the same read into an Alt
    // key. Vim expects the terminal's ESC prefix, including a fast Esc + :w.
    if (pressed.meta) {
      key("Escape", 27);
      text ??= pressed.sequence;
      pressed = { ...pressed, meta: false };
      if (text?.startsWith("\x1b")) text = text.slice(1);
    }
    if (special[pressed.name]) { key(...special[pressed.name], pressed); return; }
    if (/^f(?:[1-9]|1[0-2])$/.test(pressed.name ?? "")) {
      const number = Number(pressed.name.slice(1));
      key(`F${number}`, 111 + number, pressed);
      return;
    }
    const value = pressed.ctrl && pressed.name?.length === 1 ? pressed.name : text;
    if (value) for (const character of value) characterKey(character, { ...pressed, alt: pressed.meta });
  };
  const type = text => {
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code === 27) key("Escape", 27);
      else if (character === "\n" || character === "\r") key("Enter", 13);
      else if (code > 0 && code < 27) key(String.fromCharCode(code + 96), code + 64, { ctrl: true });
      else characterKey(character);
    }
  };
  const onResize = () => { screen.resize(output.columns ?? 80, output.rows ?? 24); resize(); };
  const abort = () => fail(signal.reason ?? new Error("Vim aborted"));
  const raw = input?.isRaw ?? false;
  try {
    worker.on("error", fail);
    worker.on("exit", code => { if (!settled) fail(new Error(`Vim worker exited unexpectedly (${code})`)); });
    worker.on("message", message => {
      switch (message.kind) {
        case "draw": screen.draw(message.event); break;
        case "done": queue.shift(); busy = false; pump(); break;
        case "started": Promise.resolve().then(() => onReady?.({ type, key })).catch(fail); break;
        case "exit": if (!settled) { settled = true; resolveExit(message.status); } break;
        case "error": fail(new Error(`vim: ${message.message}`)); break;
        case "fs": {
          // The C runtime blocks this thread's peer until its async DO RPC
          // completes. Only this small fixed filesystem protocol crosses over.
          Promise.resolve().then(() => request(message.method, message.args)).then(
            result => ({ result }),
            error => ({ error: error.message ?? "Filesystem operation failed", code: error.code ?? "EIO" }),
          ).then(response => {
            let bytes = new TextEncoder().encode(JSON.stringify(response));
            if (bytes.length > message.buffer.byteLength - 8) bytes = new TextEncoder().encode(JSON.stringify({ error: "Filesystem response is too large", code: "EFBIG" }));
            const header = new Int32Array(message.buffer, 0, 2);
            new Uint8Array(message.buffer, 8, bytes.length).set(bytes);
            header[1] = bytes.length;
            Atomics.store(header, 0, 1);
            Atomics.notify(header, 0, 1);
          }).catch(fail);
          break;
        }
        // :! JavaScript and clipboard messages intentionally have no host
        // evaluator. The WASM editor only receives filesystem access.
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    screen.start();
    if (input) {
      emitKeypressEvents(input);
      input.on("keypress", keypress);
      input.setRawMode(true);
      input.resume();
    }
    output.on?.("resize", onResize);
    worker.postMessage({
      kind: "start", debug: false, perf: false, buffer: shared, clipboard: false,
      canvasDomWidth: screen.columns * screen.cellWidth, canvasDomHeight: screen.rows * screen.cellHeight,
      persistent: [], dirs: [], files: {}, fetchFiles: {}, cmdArgs,
    });
    return await exit;
  } finally {
    settled = true;
    signal?.removeEventListener("abort", abort);
    input?.off("keypress", keypress);
    if (input) { input.setRawMode(raw); input.pause(); }
    output.off?.("resize", onResize);
    await worker.terminate();
    screen.close();
  }
}
