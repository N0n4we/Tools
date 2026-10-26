import { DurableFs } from "@stablemodels/durable-bash/fs";
import type { FsObject } from "@stablemodels/durable-bash/object";
import { Bash } from "just-bash/browser";
import { ownerId } from "../src/env.js";
import { HttpError, errorResponse, jsonBody, secretsEqual, textField } from "../src/http.js";

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

export default {
  async fetch(request: Request, env: DebugEnv): Promise<Response> {
    let response: Response;
    try {
      if (new URL(request.url).pathname !== "/bash" || request.method !== "POST") throw new HttpError(404, "Not found");
      if (!await secretsEqual(request.headers.get("x-debug-token"), env.DEBUG_TOKEN)) throw new HttpError(401, "Invalid debug token");
      const body = await jsonBody(request);
      const command = textField(body.command, "command", 32_000);
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
      await guarded.sync();
      const bash = new Bash({ fs: guarded, cwd, env: { TZ: "Asia/Shanghai", ...variables as Record<string, string> } });
      response = Response.json(await bash.exec(command, { rawScript: true, signal: request.signal }));
    } catch (error) { response = errorResponse(error); }
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  },
} satisfies ExportedHandler<DebugEnv>;
