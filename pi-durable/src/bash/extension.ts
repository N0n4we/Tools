import { DurableFs } from "@stablemodels/durable-bash/fs";
import type { FsObject } from "@stablemodels/durable-bash/object";
import { Bash } from "just-bash/browser";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { WebAccess } from "../web/access.js";

export function bashExtension(files: FsObject, cwd: string, web: WebAccess) {
  return defineExtension({
    name: "durable-bash",
    sections: [section("bash", () => `bash 是 just-bash 虚拟 shell，工作目录 ${cwd}。长期记忆位于 MEMORY.md、USER.md、failures.md、可选 STANDING.md；Skills 位于 skills/<slug>/SKILL.md，参考文件在同目录下。使用 cat、find、grep 读取和检索，使用 mkdir、printf、重定向等保存或更新。修改前先读取当前内容，保留用户修正，不要未经用户要求删除有用资料或文件。支持内置文本命令、管道和脚本，不支持真实子进程、Node、Python 或 ffmpeg。内置 curl 可读取公开 HTTPS 的 GET/HEAD，支持管道和下载到虚拟文件；不支持 POST 等写操作、内网、Host 覆盖或部署密钥。每个 HTTP 请求最多 15 秒、响应最多 1 MiB、最多 4 次重定向，并遵守 WEB_ALLOWED_HOSTS；落盘仍受单文件 256 KiB 限制。需要等待时，在调用工具的同一条 assistant 消息中先写给用户的正文，再单独调用 bash 执行 sleep 120s；正文会自动发送。等待结束后本对话会接入新用户回复，由你决定后续操作，不要在脚本里写不检查用户回复的提醒循环。每次调用重置环境变量和工作目录，只有文件持久化。`)],
    tools: [defineTool({
      name: "bash",
      description: "在持久化的 just-bash 虚拟文件系统执行命令，返回 stdout/stderr；非零退出码为错误。支持 curl 读取公开 HTTPS GET/HEAD、sleep 等待新输入；无内网或部署密钥。",
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 32_000 }), timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 600, description: "超时秒数，默认 180 秒，最多 600 秒" })) }),
      outputLimits: { retain: "tail" },
      async execute(args, api, context) {
        const signal = AbortSignal.any([AbortSignal.timeout(Math.ceil((args.timeout ?? 180) * 1000)), ...(context.abortSignal ? [context.abortSignal] : [])]);
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
        const bash = new Bash({ fs: guarded, cwd, env: {}, fetch: (url, options) => web.request(url, { ...options, signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]) }), sleep: async ms => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await awaitWithContext(new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(ms, 600_000)); }), invocation); }
          finally { clearTimeout(timer); }
        } });
        signal.throwIfAborted();
        const result = await awaitWithContext(bash.exec(args.command, { rawScript: true, signal }), invocation);
        api.output(result.stdout + result.stderr);
        if (result.exitCode !== 0) throw new Error(`Command exited with code ${result.exitCode}`);
        return {};
      },
    })],
  });
}
