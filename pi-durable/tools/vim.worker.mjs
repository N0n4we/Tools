import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

// vim-wasm 0.0.13 uses a synchronous browser worker. Keep its runtime in a
// dedicated Node thread, with MEMFS for Vim's bundled runtime and RPC for files.
const assets = dirname(createRequire(import.meta.url).resolve("vim-wasm/package.json"));
const data = readFileSync(join(assets, "vim.data"));
const send = message => parentPort.postMessage(message);
const context = {
  Module: {
    wasmBinary: readFileSync(join(assets, "vim.wasm")),
    getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    print() {}, printErr() {},
  },
  location: { pathname: `${assets}/`, href: `file://${assets}/vim.js` },
  importScripts() { throw new Error("Unexpected Vim script import"); },
  postMessage: send,
  onmessage: null,
  console: { log() {}, error() {}, warn() {} },
  performance, setTimeout, clearTimeout, TextEncoder, TextDecoder, WebAssembly, Atomics,
  SharedArrayBuffer, ArrayBuffer, DataView, Uint8Array, Uint16Array, Uint32Array,
  Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
};
context.self = context;
runInNewContext(readFileSync(join(assets, "vim.js"), "utf8"), context, { filename: join(assets, "vim.js") });

function attachFilesystem(FS) {
  const errno = { ENOENT: 44, EISDIR: 31, ENOTDIR: 54, EEXIST: 20, ENOTEMPTY: 55, EINVAL: 28, ELOOP: 32, EACCES: 2, EROFS: 69, EFBIG: 22, EIO: 29 };
  function rpc(method, args) {
    const buffer = new SharedArrayBuffer(1024 * 1024);
    const header = new Int32Array(buffer, 0, 2);
    send({ kind: "fs", method, args, buffer });
    Atomics.wait(header, 0, 0);
    const response = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, header[1])));
    if (response.error) throw new FS.ErrnoError(errno[response.code] ?? errno.EIO);
    return response.result;
  }
  const writable = () => { if (workerData.readOnly) throw new FS.ErrnoError(errno.EROFS); };
  const nodePath = node => FS.getPath(node);
  const childPath = (parent, name) => `${nodePath(parent).replace(/\/$/, "")}/${name}`;
  const modeOf = stat => (stat.isDirectory ? 0o40000 : stat.isSymbolicLink ? 0o120000 : 0o100000) | stat.mode;
  function node(parent, name, stat, fresh = false) {
    const result = FS.createNode(parent, name, modeOf(stat), 0);
    result.node_ops = nodes;
    result.stream_ops = streams;
    result.remote = true;
    result.fresh = fresh;
    result.remoteSize = stat.size;
    return result;
  }
  const nodes = {
    getattr(node) {
      const stat = node.fresh ? { mode: node.mode & 0o7777, size: node.remoteSize, mtime: new Date(), isDirectory: false } : rpc("lstat", [nodePath(node)]);
      const date = new Date(stat.mtime);
      return { dev: 1, ino: node.id, mode: modeOf(stat), nlink: 1, uid: 0, gid: 0, rdev: 0, size: stat.size, atime: date, mtime: date, ctime: date, blksize: 4096, blocks: Math.ceil(stat.size / 4096) };
    },
    setattr(node, attributes) {
      writable();
      if (attributes.mode !== undefined) {
        if (!node.fresh) rpc("chmod", [nodePath(node), attributes.mode & 0o7777]);
        node.mode = attributes.mode;
      }
      if (attributes.size !== undefined) {
        if (attributes.size > workerData.maxFileBytes) throw new FS.ErrnoError(errno.EFBIG);
        node.truncateSize = attributes.size;
      }
    },
    lookup: (parent, name) => node(parent, name, rpc("lstat", [childPath(parent, name)])),
    mknod(parent, name, mode) {
      writable();
      if (FS.isDir(mode)) {
        rpc("mkdir", [childPath(parent, name)]);
        return node(parent, name, { mode: mode & 0o7777, isDirectory: true, size: 0 });
      }
      if (!FS.isFile(mode)) throw new FS.ErrnoError(errno.EINVAL);
      return node(parent, name, { mode: mode & 0o7777, size: 0 }, true);
    },
    rename(node, parent, name) {
      writable();
      rpc("rename", [nodePath(node), childPath(parent, name)]);
      node.parent = parent;
      node.name = name;
    },
    unlink(parent, name) { writable(); rpc("unlink", [childPath(parent, name)]); },
    rmdir(parent, name) { writable(); rpc("unlink", [childPath(parent, name)]); },
    readdir: node => [".", "..", ...rpc("readdir", [nodePath(node)])],
    readlink: node => rpc("readlink", [nodePath(node)]),
  };
  const streams = {
    open(stream) {
      const writing = (stream.flags & 3) !== 0;
      if (writing) writable();
      stream.bytes = stream.node.fresh || stream.node.truncateSize === 0 ? new Uint8Array() : new Uint8Array(Buffer.from(rpc("read", [nodePath(stream.node)]), "base64"));
      if (stream.node.truncateSize !== undefined) {
        const resized = new Uint8Array(stream.node.truncateSize);
        resized.set(stream.bytes.subarray(0, resized.length));
        stream.bytes = resized;
        delete stream.node.truncateSize;
      }
      stream.changed = writing && (stream.node.fresh || (stream.flags & 512) !== 0);
    },
    close(stream) {
      if (!stream.changed || stream.failed) return;
      rpc("write", [nodePath(stream.node), Buffer.from(stream.bytes).toString("base64")]);
      stream.node.fresh = false;
      stream.node.remoteSize = stream.bytes.length;
    },
    read(stream, buffer, offset, length, position) {
      const bytes = stream.bytes.subarray(position, position + length);
      buffer.set(bytes, offset);
      return bytes.length;
    },
    write(stream, buffer, offset, length, position) {
      writable();
      if (position + length > workerData.maxFileBytes) {
        stream.failed = true;
        throw new FS.ErrnoError(errno.EFBIG);
      }
      if (position + length > stream.bytes.length) {
        const resized = new Uint8Array(position + length);
        resized.set(stream.bytes);
        stream.bytes = resized;
      }
      stream.bytes.set(buffer.subarray(offset, offset + length), position);
      stream.changed = true;
      return length;
    },
    llseek(stream, offset, whence) {
      const position = offset + (whence === 1 ? stream.position : whence === 2 ? stream.bytes.length : 0);
      if (position < 0) throw new FS.ErrnoError(errno.EINVAL);
      return position;
    },
  };
  // Keep only Vim's runtime and devices in MEMFS. Overlay local parent
  // directories too, so virtual paths under /home, /usr or /tmp still work.
  const runtimePath = path => /^(?:\/dev|\/proc|\/usr\/local\/share\/vim|\/home\/web_user\/\.vim|\/tmp\/\.pi-vim-wasm)(?:\/|$)/.test(path);
  function overlay(directory) {
    if (!FS.isDir(directory.mode) || directory.remote || directory.overlay || runtimePath(nodePath(directory))) return;
    directory.overlay = true;
    const local = directory.node_ops;
    directory.node_ops = {
      ...local,
      lookup(parent, name) {
        try {
          const entry = local.lookup(parent, name);
          overlay(entry);
          return entry;
        } catch (error) { if (error.errno !== errno.ENOENT) throw error; }
        return nodes.lookup(parent, name);
      },
      mknod(parent, name, mode, device) {
        return runtimePath(childPath(parent, name)) ? local.mknod(parent, name, mode, device) : nodes.mknod(parent, name, mode);
      },
      readdir(parent) {
        let remote = [];
        try { remote = nodes.readdir(parent); }
        catch (error) { if (error.errno !== errno.ENOENT) throw error; }
        return [...new Set([...local.readdir(parent), ...remote])];
      },
      rename: (entry, parent, name) => entry.remote ? nodes.rename(entry, parent, name) : local.rename(entry, parent, name),
      unlink(parent, name) {
        return FS.lookupNode(parent, name).remote ? nodes.unlink(parent, name) : local.unlink(parent, name);
      },
      rmdir(parent, name) {
        return FS.lookupNode(parent, name).remote ? nodes.rmdir(parent, name) : local.rmdir(parent, name);
      },
    };
    for (const entry of Object.values(directory.contents ?? {})) overlay(entry);
  }
  FS.mkdir("/tmp/.pi-vim-wasm");
  context.ENV.TMPDIR = "/tmp/.pi-vim-wasm";
  overlay(FS.root);
}

parentPort.once("message", async message => {
  try {
    await context.emscriptenRuntimeInitialized;
    attachFilesystem(context.FS);
    context.FS.chdir(workerData.cwd);
    context.onmessage({ data: message });
  } catch (error) { send({ kind: "error", message: error.message ?? "Could not start Vim" }); }
});
