# 线上 just-bash 调试终端

在项目根目录运行（Node 和依赖版本同主项目）：

```sh
# 首次使用：登录拥有生产 Worker 的 Cloudflare 账号
pnpm exec wrangler login

# 默认只读；填写生产 TELEGRAM_USER_ID，也可通过同名环境变量提供
node tools/bash.mjs --user 123456789

# 执行单条命令，退出码与命令一致
node tools/bash.mjs --user 123456789 -c 'find . -type f | head'

# 明确开启线上写入
node tools/bash.mjs --user 123456789 --write
```

通过 Wrangler 临时远程开发会话，将 `tools/bash.worker.ts` 绑定到根目录 `wrangler.jsonc` 中现有的 `AGENT`（Worker 名称、绑定和 `MEMORY_PREFIX` 自动读取）。不替换生产 Worker，不添加生产 HTTP 路由、DO 类或迁移；**不要部署这个调试 Worker**。需要可创建远程预览会话并访问该 Worker 的 Cloudflare 凭证。工具退出时停止开发会话。

- Bash 在临时 Cloudflare Worker 中运行，文件操作通过 `DurableFs` RPC 访问真正的生产 DO SQLite，不是本地副本。每次命令刷新路径缓存。
- 默认目录 `/hermes/<TELEGRAM_USER_ID>/`（遵循 `MEMORY_PREFIX`）；支持 `ls`、`cat`、`find`、管道、重定向等 just-bash 内置能力。
- 默认只读，在文件系统接口层阻止写入；`--write` 才允许写入，原有文件大小、数量限制和 ETag 更新仍由生产 DO 执行。只读不是 DO 冻结：连接可能唤醒 DO，初始化逻辑和 Agent 自身仍可写入。
- 每行输入一条完整命令；目录和变量通过 just-bash 返回的环境在下一行恢复，函数、别名和 shell 选项不跨行保存。多行脚本可用 `-c` 传入。独立输入 `exit`、Ctrl+D 或 Ctrl+C 退出。
- 不调用模型，不注入本机环境或部署密钥，不开放 curl 等网络命令；会话令牌每次随机生成，不写入配置。
- **写入直接作用于线上数据，没有事务级整条命令回滚、ETag 冲突检查或撤销。** 默认目录不是权限沙箱，可访问该 DO 的整个虚拟文件系统。避免与 Agent 同时编辑同一文件，修改前重读并自行备份。
- 服务端或传输错误会结束会话，不自动重试失败请求。断线或中断不保证撤销/停止已发出的远程操作；先检查文件再决定是否重试。输出按命令结束后返回，不是流式终端；just-bash 3.6.0 会丢失 stdout 字节类型标记，二进制文件请用 `base64`、`od` 等检查，不要依赖终端原始输出导出。
