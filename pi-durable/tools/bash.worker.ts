import { DurableFs } from "@stablemodels/durable-bash/fs";
import type { FsObject } from "@stablemodels/durable-bash/object";
import { Buffer } from "node:buffer";
import { Bash, defineCommand } from "just-bash/browser";
import { ownerId } from "../src/env.js";
import { HttpError, errorResponse, jsonBody, secretsEqual, textField } from "../src/http.js";
import { MAX_FILE_BYTES } from "../src/memory/store.js";

interface DebugEnv {
  AGENT: DurableObjectNamespace<FsObject>;
  TELEGRAM_USER_ID: string;
  MEMORY_PREFIX?: string;
  DEBUG_TOKEN: string;
  DEBUG_WRITE?: boolean;
}

const READ_METHODS = new Set<PropertyKey>([
  "sync", "readFile", "readFileBuffer", "exists", "stat", "lstat", "readdir", "readdirWithFileTypes",
  "resolvePath", "getAllPaths", "readlink", "realpath",
]);

async function filesystem(fs: DurableFs, body: Record<string, unknown>): Promise<unknown> {
  const args = body.args;
  if (!Array.isArray(args) || args.length > 3) throw new HttpError(400, "Invalid filesystem arguments");
  const path = (index = 0) => {
    const value = textField(args[index], "path", 512);
    if (!value.startsWith("/") || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, "Invalid virtual path");
    return value;
  };
  switch (body.method) {
    case "stat": return fs.stat(path());
    case "lstat": return fs.lstat(path());
    case "readdir": return fs.readdir(path());
    case "readlink": return fs.readlink(path());
    case "read": {
      const bytes = await fs.readFileBuffer(path());
      if (bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(413, "File is too large");
      return Buffer.from(bytes).toString("base64");
    }
    case "write": {
      if (typeof args[1] !== "string" || args[1].length > Math.ceil(MAX_FILE_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args[1])) throw new HttpError(400, "Invalid file bytes");
      const bytes = Buffer.from(args[1], "base64");
      if (bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(413, "File is too large");
      await fs.writeFile(path(), bytes);
      return null;
    }
    case "mkdir": await fs.mkdir(path()); return null;
    case "unlink": await fs.rm(path()); return null;
    case "rename": await fs.mv(path(), path(1)); return null;
    case "chmod": {
      if (!Number.isInteger(args[1]) || (args[1] as number) < 0 || (args[1] as number) > 0o7777) throw new HttpError(400, "Invalid file mode");
      await fs.chmod(path(), args[1] as number);
      return null;
    }
    default: throw new HttpError(400, "Unsupported filesystem method");
  }
}

export default {
  async fetch(request: Request, env: DebugEnv): Promise<Response> {
    let response: Response;
    const route = new URL(request.url).pathname;
    try {
      if (!["/bash", "/fs"].includes(route) || request.method !== "POST") throw new HttpError(404, "Not found");
      if (!await secretsEqual(request.headers.get("x-debug-token"), env.DEBUG_TOKEN)) throw new HttpError(401, "Invalid debug token");
      const body = await jsonBody(request, route === "/fs" ? Math.ceil(MAX_FILE_BYTES / 3) * 4 + 16_384 : 64 * 1024);
      const variables = body.env ?? {};
      if (typeof variables !== "object" || Array.isArray(variables) || Object.values(variables).some(value => typeof value !== "string")) throw new HttpError(400, "Invalid shell environment");
      const prefix = textField(env.MEMORY_PREFIX ?? "hermes/", "MEMORY_PREFIX", 512);
      if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(prefix)) throw new HttpError(400, "Invalid MEMORY_PREFIX");
      const cwd = textField((variables as Record<string, string>).PWD ?? `/${prefix.replace(/\/$/, "")}/${ownerId(env)}`, "cwd", 512);
      if (!cwd.startsWith("/")) throw new HttpError(400, "cwd must be an absolute virtual path");
      const stub = env.AGENT.get(env.AGENT.idFromName(ownerId(env)));
      const fs = new DurableFs(stub, cwd);
      const guarded = new Proxy(fs, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            request.signal.throwIfAborted();
            if (env.DEBUG_WRITE !== true && !READ_METHODS.has(key)) throw new HttpError(403, "EROFS: read-only debug session; restart with --write to modify production files");
            return value.apply(target, args);
          };
        },
      });
      if (route === "/fs") response = Response.json({ result: await filesystem(guarded, body) });
      else {
        const command = textField(body.command, "command", 32_000);
        await guarded.sync();
        let editor: { args: string[]; cwd: string; readOnly: boolean } | undefined;
        let standalone = false;
        const commands = ["vim", "vi"].map(name => defineCommand(name, async (args, context) => {
          if (args.length === 1 && args[0] === "--version") return { stdout: "VIM - Vi IMproved 8.2.0055 (vim-wasm 0.0.13)\n", stderr: "", exitCode: 0 };
          if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return { stdout: "Usage: vim [-R] [+LINE] [--] [FILE ...]\nWASM Vim in the interactive debug terminal. :w saves production files with --write; :q quits.\nRun vim as a separate command, without pipes or redirections.\n", stderr: "", exitCode: 0 };
          if (!standalone || body.terminal !== true) return { stdout: "", stderr: "vim: requires an interactive debug terminal and a separate command without pipes or redirections\n", exitCode: 2 };
          editor = { args, cwd: context.cwd, readOnly: env.DEBUG_WRITE !== true };
          return { stdout: "", stderr: "", exitCode: 0 };
        }));
        const bash = new Bash({ fs: guarded, cwd, env: { TZ: "Asia/Shanghai", ...variables as Record<string, string> }, customCommands: commands });
        const ast = bash.transform(command).ast;
        const statement = ast.statements[0];
        const pipeline = statement?.pipelines[0];
        const simple = pipeline?.commands[0];
        standalone = ast.statements.length === 1 && statement?.pipelines.length === 1 && !statement.background
          && pipeline?.commands.length === 1 && !pipeline.negated && !pipeline.timed
          && simple?.type === "SimpleCommand" && !simple.redirections.length && !simple.assignments.length;
        response = Response.json({ ...await bash.exec(command, { rawScript: true, signal: request.signal }), ...(editor ? { editor } : {}) });
      }
    } catch (error) {
      if (route === "/fs" && !(error instanceof HttpError)) {
        const message = error instanceof Error ? error.message : "Filesystem operation failed";
        const code = message.match(/\b(ENOENT|EISDIR|ENOTDIR|EEXIST|ENOTEMPTY|EINVAL|ELOOP|EACCES|EROFS)\b/)?.[1];
        response = Response.json({ error: code ? message : "Filesystem operation failed", code: code ?? "EIO" }, { status: code === "ENOENT" ? 404 : 400 });
      } else response = errorResponse(error);
    }
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  },
} satisfies ExportedHandler<DebugEnv>;
