# 线上 just-bash 调试终端

在项目根目录运行（Node 和依赖版本同主项目）：

```sh
# 首次使用：登录拥有生产 Worker 的 Cloudflare 账号
pnpm exec wrangler login

# 默认只读；填写生产 TELEGRAM_USER_ID，也可通过同名环境变量提供
node tools/bash.mjs --user 123456789

# 执行单条命令，退出码与命令一致
node tools/bash.mjs --user 123456789 -c 'find . -type f | head'

# 网络较慢或需要运行长命令时，调整每次请求的超时（秒，默认 60）
node tools/bash.mjs --user 123456789 --timeout 120

# 明确开启线上写入
node tools/bash.mjs --user 123456789 --write
```

连接后可直接输入 `vim MEMORY.md`（也支持 `vi`）。使用的是 [vim.wasm](https://github.com/rhysd/vim.wasm) 的真实 Vim 8.2，不需要本机安装 Vim，也不需要浏览器：

```text
vim MEMORY.md
vim +20 skills/demo/SKILL.md
vim -R USER.md
vim "带空格的文件.txt"
```

`vim` / `vi` 通过 just-bash 的 `defineCommand` 注册，仅用于这个临时调试终端。WASM 在客户端的 Node 工作线程中运行，画面转换为终端输出，文件操作经带会话令牌的临时 Worker RPC 访问生产 DO。必须使用真实交互终端，并独立执行 Vim 命令；先 `cd` 再输入 `vim`，不支持将编辑会话放入管道、重定向或 `&&` 等复合命令。支持无文件启动、多个文件、`-R`、`+行号` 和 `--`；`vim --help`、`vim --version` 可用于非交互检查。

- `i` 编辑，Esc 返回普通模式；`:w` 立即保存线上文件，`:q` 返回 just-bash，`:wq` 保存并返回，`:q!` 丢弃尚未保存的修改。`:q!` 不撤销先前的 `:w`。
- 默认只读，可查看和修改内存缓冲区，但 `:w!` 也不能写入生产 DO；启动调试工具时加 `--write` 才允许保存。每次保存仍受生产文件大小、数量配额约束；保存失败会在 Vim 中报错，不自动重试。
- `:e 路径`、`:w 新路径`、`:next` 等访问同一虚拟文件系统，支持相对路径和绝对路径。Vim 自带的 `/usr/local/share/vim`、`/home/web_user/.vim`、`/dev`、`/proc` 和 `/tmp/.pi-vim-wasm` 保留为内存运行时目录。
- 不加载本机 vimrc，不提供本机剪贴板或 `:!` 执行能力。编辑时间不计入请求超时；每次远程文件操作仍受 `--timeout` 限制。Vim 内的 Ctrl+C 按 Vim 的行为处理，用 `:q` 退出编辑器。

通过 Wrangler 临时远程开发会话，将 `tools/bash.worker.ts` 绑定到根目录 `wrangler.jsonc` 中现有的 `AGENT`（Worker 名称、绑定和 `MEMORY_PREFIX` 自动读取）。不替换生产 Worker，不添加生产 HTTP 路由、DO 类或迁移；**不要部署这个调试 Worker**。需要可创建远程预览会话并访问该 Worker 的 Cloudflare 凭证。工具退出时停止开发会话。

- Bash 在临时 Cloudflare Worker 中运行，文件操作通过 `DurableFs` RPC 访问真正的生产 DO SQLite。Vim 仅在编辑期间缓存打开的缓冲区，保存时等待线上写入结果；每次 shell 命令刷新路径缓存。
- 默认目录 `/hermes/<TELEGRAM_USER_ID>/`（遵循 `MEMORY_PREFIX`）；支持 `ls`、`cat`、`find`、管道、重定向等 just-bash 内置能力。
- 默认只读，在文件系统接口层阻止写入；`--write` 才允许写入，原有文件大小、数量限制和 ETag 更新仍由生产 DO 执行。只读不是 DO 冻结：连接可能唤醒 DO，初始化逻辑和 Agent 自身仍可写入。
- 每行输入一条完整命令；目录和变量通过 just-bash 返回的环境在下一行恢复，函数、别名和 shell 选项不跨行保存。多行脚本可用 `-c` 传入。独立输入 `exit`、Ctrl+D 或 Ctrl+C 退出。
- 启动时先连接 Cloudflare 远程预览会话并执行 `pwd`，显示 `Connected.` 和 `just-bash(...) ...>` 提示符后再输入命令。等待远程请求时每 5 秒显示一次进度；每次请求默认 60 秒超时（包含远程命令的执行时间），可用 `--timeout 秒数` 调整。超时会结束会话，不自动重试请求。
- 不调用模型，不注入本机环境或部署密钥，不开放 curl 等网络命令；会话令牌每次随机生成，不写入配置。
- **写入直接作用于线上数据，没有事务级整条命令回滚、ETag 冲突检查或撤销。** 默认目录不是权限沙箱，可访问该 DO 的整个虚拟文件系统。避免与 Agent 同时编辑同一文件，修改前重读并自行备份。
- shell 的服务端或传输错误会结束会话，不自动重试失败请求；Vim 文件操作失败会在编辑器中报错，保留缓冲区供处理。断线或中断不保证撤销/停止已发出的远程操作；先检查文件再决定是否重试。普通 shell 输出按命令结束后返回，Vim 单独接管交互终端；just-bash 3.6.0 会丢失 stdout 字节类型标记，二进制文件请用 `base64`、`od` 等检查，不要依赖终端原始输出导出。
