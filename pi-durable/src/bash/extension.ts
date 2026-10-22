import { DurableFs } from "@stablemodels/durable-bash/fs";
import type { FsObject } from "@stablemodels/durable-bash/object";
import { Bash } from "just-bash/browser";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { WebAccess } from "../web/access.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024;

export function bashExtension(files: FsObject, cwd: string, web: WebAccess) {
  return defineExtension({
    name: "durable-bash",
    tools: [defineTool({
      name: "bash",
      description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 32_000, description: "Shell command to execute" }), timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })) }),
      outputLimits: { maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES, retain: "tail" },
      async execute(args, api, context) {
        if (args.timeout !== undefined) {
          if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
          if (args.timeout * 1000 > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
        }
        const controller = new AbortController();
        const timer = args.timeout === undefined ? undefined : setTimeout(() => controller.abort(), args.timeout * 1000);
        const signal = AbortSignal.any([controller.signal, ...(context.abortSignal ? [context.abortSignal] : [])]);
        const invocation = withAbortSignal(signal, context);
        try {
          // The adapter only uses FsObject's filesystem RPC methods; calls stay in this DO.
          const fs = new DurableFs(files as unknown as DurableObjectStub<FsObject>, cwd);
          const guarded = new Proxy(fs, {
            get(target, key) {
              const value = Reflect.get(target, key);
              return typeof value === "function" ? (...args: unknown[]) => { signal.throwIfAborted(); return value.apply(target, args); } : value;
            },
          });
          await guarded.sync();
          const bash = new Bash({ fs: guarded, cwd, env: { TZ: "Asia/Shanghai" }, fetch: (url, options) => web.request(url, { ...options, signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]) }), sleep: async ms => {
            // shortcut: just-bash caps sleep at one hour; revisit if that upstream limit changes.
            let sleepTimer: ReturnType<typeof setTimeout> | undefined;
            try { await awaitWithContext(new Promise<void>(resolve => { sleepTimer = setTimeout(resolve, ms); }), invocation); }
            finally { clearTimeout(sleepTimer); }
          } });
          signal.throwIfAborted();
          const result = await awaitWithContext(bash.exec(args.command, { rawScript: true, signal }), invocation);
          const output = result.stdout + result.stderr;
          api.output(output);
          if (api.retainedOutput().truncated) {
            const path = `${cwd}/.tmp/pi-bash-${crypto.randomUUID()}.log`;
            await guarded.mkdir(`${cwd}/.tmp`, { recursive: true });
            if (await guarded.exists(path)) throw new Error("Temporary output file already exists");
            try { await guarded.writeFile(path, output); }
            catch (error) { throw new Error(`Could not save full output: ${error instanceof Error ? error.message : "write failed"}`); }
            api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${path}` });
          }
          if (result.exitCode !== 0) throw new Error(`Command exited with code ${result.exitCode}`);
          return {};
        } catch (error) {
          if (signal.aborted) throw new Error(context.abortSignal?.aborted ? "Command aborted" : `Command timed out after ${args.timeout} seconds`);
          throw error;
        } finally { clearTimeout(timer); }
      },
    })],
  });
}
