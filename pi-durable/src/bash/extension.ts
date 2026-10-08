import { DurableFs } from "@stablemodels/durable-bash/fs";
import type { FsObject } from "@stablemodels/durable-bash/object";
import { Bash } from "just-bash";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export function bashExtension(files: FsObject, cwd: string) {
  return defineExtension({
    name: "durable-bash",
    sections: [section("bash", () => `bash 是 just-bash 虚拟 shell，工作目录 ${cwd}。记忆文件和 skills/ 与文件工具共享同一个持久化文件系统。支持内置文本命令、管道和脚本，不支持真实子进程、Node、Python、ffmpeg 或网络。修改长期记忆优先使用带 etag 的文件工具；bash 写入会使旧 etag 失效。不要未经用户要求删除文件。每次调用重置环境变量和工作目录，只有文件持久化。`)],
    tools: [defineTool({
      name: "bash",
      description: "在持久化的 just-bash 虚拟文件系统执行命令，返回 stdout/stderr；非零退出码为错误。无网络或部署密钥。",
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 32_000 }), timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 60, description: "超时秒数，默认 30 秒，最多 60 秒" })) }),
      outputLimits: { retain: "tail" },
      async execute(args, api, context) {
        const signal = AbortSignal.any([AbortSignal.timeout(Math.ceil((args.timeout ?? 30) * 1000)), ...(context.abortSignal ? [context.abortSignal] : [])]);
        const invocation = withAbortSignal(signal, context);
        // The adapter only uses FsObject's filesystem RPC methods; calls stay in this DO.
        const fs = new DurableFs(files as unknown as DurableObjectStub<FsObject>, cwd);
        const guarded = new Proxy(fs, {
          get(target, key) {
            const value = Reflect.get(target, key);
            return typeof value === "function" ? (...args: unknown[]) => { signal.throwIfAborted(); return value.apply(target, args); } : value;
          },
        });
        await guarded.sync();
        // ponytail: just-bash 1.5 expands globs only in the last path segment; upgrade when broader globbing is needed.
        const bash = new Bash({ fs: guarded, cwd, env: {}, sleep: async ms => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await awaitWithContext(new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(ms, 60_000)); }), invocation); }
          finally { clearTimeout(timer); }
        } });
        signal.throwIfAborted();
        const result = await awaitWithContext(bash.exec(args.command, { rawScript: true }), invocation);
        api.output(result.stdout + result.stderr);
        if (result.exitCode !== 0) throw new Error(`Command exited with code ${result.exitCode}`);
        return {};
      },
    })],
  });
}
