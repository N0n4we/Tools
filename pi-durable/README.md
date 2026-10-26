# Pi Durable Telegram Agent · Cloudflare Workers

单用户 Agent 后端，使用 `@earendil-works/pi-durable`，不启动容器。对外只开放 `POST /telegram/webhook`，校验 webhook Secret；不提供健康检查或管理 API。

## 功能

- 对话：注册 Telegram Bot 到此 Worker 的 webhook；所有已提交的 assistant 消息自动发送，按 `content` 块区分思考、回复和工具调用，混合消息保持原顺序。每次对话模型请求中，用户消息、assistant 历史和工具结果开头均添加 `[yyyy-mm-dd hh:mm:ss]`，使用各条消息自身时间戳的上海时间（Asia/Shanghai，UTC+8），仅在请求副本中添加，不改写原始记录。前缀是上下文元数据；角色动作、神态的用户格式要求是全角 `（）`。任务执行期间的新用户消息以 Pi steering 输入接入同一对话，在当前工具轮次结束后供模型读取，不必等持续任务完全结束。
- `/compact`：owner 在私聊发送此命令后，按现有串行队列执行 Pi Durable 上下文压缩并回复结果，不把命令交给对话模型。手动压缩无最小 token 门槛，仅保留最近一个安全消息边界及其后的内容；没有可压缩的历史内容时跳过。自动压缩策略不变，仍默认保留最近约 20,000 token。历史记录和记忆文件保留，摘要生成会产生模型费用。
- `/new`：owner 在私聊发送此命令后，按同一串行队列归档历史上下文，再丢弃 Pi 当前会话的全部记录（含历史、摘要和工具任务），不压缩、不调用模型。正在执行的任务先完成；命令之后的消息不会接入旧会话。记忆、Skill 和其他 bash 文件、队列及 Telegram 去重/投递状态保留。删除与待发送确认原子保存，重启或重复 update 不会再次清空新会话；归档可通过 bash 读取，不提供自动恢复到 Pi 的命令。
- `/retry`：owner 在私聊发送此命令后，按同一串行队列重试最近一条普通用户消息；正在运行的轮次先结束，命令之后的消息不会被接入旧轮次。保留原用户消息（包括原时间戳）及更早历史，先按已有消息 ID 删除之后的 Telegram 正文、思考、工具卡和语音，再移除其后的 Pi 模型/展示内容与摘要边界，仅保留记录 ID 维护任务引用，然后从原消息重新生成；命令本身不进入模型上下文。清理完成与重试检查点原子保存，重复 update 或重启不会再次删除新回复。`/new` 后不再重试旧会话。Telegram 删除受 [Bot API 删除限制](https://core.telegram.org/bots/api#deletemessages)（通常 48 小时）约束；删除失败或发送回执不完整时停止重试并提示，已分批删除的 Telegram 消息不会恢复。重试会重新调用模型和工具、产生费用，不回滚先前已修改的文件/记忆或外部副作用。
- 叫醒：每天北京时间 08:00 仅向 Pi 提交一次文字叫醒任务。Pi 在同一条 assistant 消息中写简短中文起床提醒并调用 bash 的 `sleep 120s`；等待后读取新回复，直到用户明确表示清醒或累计 6 小时。没有专用叫醒状态、确认工具或循环调度钩子。

压缩任务 ID 会持久化，以便重启后继续等待原任务；创建任务与保存 ID 之间的崩溃窗口可能重复生成摘要，不删除历史记录。

`/compact`、`/new`、`/retry` 执行前都会将当前全部 Pi 历史记录按 ID 顺序归档到 bash 工作目录的 `archives/<请求时间戳>-<命令>-<任务 ID>/context.json.part-*`，包括原始消息、思考、工具调用/结果和已有摘要；空历史保存为 `[]`，命令本身不进入归档。分片均为完整 UTF-8 文本且不超过 256 KiB，按文件名顺序拼接即为历史记录 JSON 数组，例如 `cat archives/<归档目录>/context.json.part-* | jq .`。归档文件和任务检查点原子保存，重复 update 或重启不会重复归档或覆盖已有文件；归档失败则停止命令，`/retry` 也不会开始删除 Telegram 回复。归档不自动注入模型上下文，不自动清理，仍受命名空间 2,000 个文件的配额约束；包含原始敏感对话内容，仅保存在同一 DO 的 just-bash 文件系统，不是完整数据库备份，也不回滚文件或外部副作用。

## 流程图

```text
Telegram webhook
          │
          ▼
每个 TELEGRAM_USER_ID 一个 Durable Object
  持久化队列 → Pi Durable → OpenRouter
  新用户消息 ── steer ──┘
                    ├─ Hermes / Skills / bash → 本 DO 的 just-bash 文件系统
                    ├─ Web Access      → HTTPS / Exa / Brave / Tavily
                    ├─ assistant/content + 执行状态 → 持久化发件状态 → Telegram sendRichMessage / sendMessage / editMessageText
                    └─ telegram_speak  → OpenRouter MP3 → Telegram sendVoice
  持久化发件状态 → Telegram sendMessage
  Alarm → 通用队列恢复（不调度叫醒轮次）
```

## 工具调用

- **记忆与 Skills**：通过 bash 的 `cat`、`find`、`grep` 读取和检索 `MEMORY.md`、`USER.md`、`failures.md`、可选 `STANDING.md` 及嵌套 `skills/**/SKILL.md` 和参考文本，通过 `mkdir`、`printf`、重定向等保存或更新；不另注册记忆或 Skill 工具。文件保存在 `@stablemodels/durable-bash` 的 SQLite 文件表，路径为 `/hermes/<TELEGRAM_USER_ID>/`（可通过 `MEMORY_PREFIX` 调整）。长期记忆与 Skill 目录简介仍自动注入提示词。bash 写入、复制、移动或重建文件使旧 ETag 失效，但 shell 覆写本身不做 ETag 冲突检查，修改前应重读并保留用户修正。不是向量检索。
- **bash**：现有 Agent DO 继承 `FsObject`，通过 `DurableFs` 接入 just-bash，无需新增 DO binding。工具描述及参数说明与 Pi CLI 1.3.0 对齐；支持内置文本命令、管道、重定向和 shell 脚本；所有文件持久化，环境变量和工作目录每次重置，默认设置 `TZ=Asia/Shanghai`，`date` 使用上海时间（UTC+8）。无工具级默认超时，显式 `timeout` 为有限正秒数，最多 2,147,483.647 秒；just-bash 自身将单次 `sleep` 限制为 1 小时，其他执行限制及任务总计 6 小时上限保留，取消后阻止后续文件操作。模型保留输出最后 2,000 行或 50 KiB（先达到的限制生效），截断时将完整输出保存在工作目录的 `.tmp/pi-bash-<UUID>.log`，并返回可供后续 bash 读取的路径。命令仍限制为 1–32,000 字符，单文件上限 256 KiB，记忆命名空间最多 2,000 个文件（含临时输出）；完整输出无法落盘时明确报错，不绕过配额，也不覆盖已有文件。不向 shell 注入部署密钥；网络读取由内置 curl 和现有 Web 工具提供。不是完整 POSIX shell，也不等同于 Pi CLI 的原生进程后端：durable-bash 的硬链接是内容快照，不共享后续修改；不构建 Workers 无法加载的原生 XZ/Zstd 压缩模块。
- **内置 curl**：通过 `new Bash({fetch: ...})` 启用 just-bash 自带命令，不自行实现命令或参数解析，也不新增模型工具。支持 `curl -fsS https://example.com | head`、`curl -fsS -o page.txt https://example.com` 等管道和原始字节下载；仅开放公开 HTTPS 的 GET/HEAD，禁止请求体、POST 等其他方法、内网地址和 Host 覆盖。与 `fetch_content` 共用 URL、`WEB_ALLOWED_HOSTS` 和逐跳 DNS 预检；跨域重定向清空自定义请求头，不自动附带部署密钥。每个请求最多 15 秒、响应最多 1 MiB、最多 4 次重定向，curl 可进一步缩小超时和重定向限制；下载落盘仍受 256 KiB 文件上限约束，取消 bash 会中止请求并阻止后续文件操作。**DNS 预检不能将实际 Workers fetch 连接锁定到已检查的 IP，仍有 DNS 重绑定竞态；严格隔离需受控出网代理，不应把这视为完整 SSRF 防护。**
- **assistant 消息**：参考 [`@llblab/pi-telegram` 的发送与展示方式](https://github.com/llblab/pi-telegram/blob/main/docs/outbound.md#technical-activity)，逐块读取 root 对话的 `content.type`，不再拼成一条带分类标签的纯文本：
  - `text`：每个完整正文块独立发送为原生 Rich Markdown，保持中途正文先于最终回复，不加“回复”前缀。移除模型复述在开头的裸时间标签（兼容旧版连字符格式），保留正文引用、代码块中的日期及动作原文；思考展示同样移除开头的时间标签。每块最多保留 20,000 字符，按 4,000 字符拆分且不切开 emoji；长 Markdown 跨块可能破坏语法，确认的 Rich HTTP 400 拒绝仅回退一次到转义的 HTML 字面文本。
  - `thinking`：独立的 HTML `<blockquote expandable>`，保留最新 1,200 字符窗口。读取 Pi Durable 已持久化的进度，最多每两秒更新一次同一条消息，完成时刷新并保留引用；不是逐 token 刷屏。只提前展示位于正文/工具之前的 thinking，后续思考等前面的内容发送后再展示，以保持顺序。只使用 provider 暴露的思考文本，空/隐藏思考跳过，不解码签名、不捏造思考。引用内按字面文本展示，不解释 Markdown。
  - `toolCall`：单独的原生 Rich 折叠工具卡，默认收起根节点；展开后有默认打开的 `arguments` 子节点和 JSON 代码块。先显示 `requested`，根据真实 Pi 工具任务的执行意图变为 `running`，根据结果/终止状态更新原卡为 `done` 或 `failed`；模型发出调用不代表执行成功。参数最多保留 1,200 字符，stdout/stderr、结果正文和内部错误不转发。确认的 Rich HTTP 400 发送拒绝回退一次到可展开 HTML 引用，此后保持同一格式编辑；编辑失败不会另发替代卡片。
  - 正文、思考和工具卡按源顺序共用 FIFO。每个块的发送意图、格式、消息 ID 和更新版本持久化，完成后的旧进度或工具启动不会覆盖新状态；旧版纯文本回执仍能恢复而不会再发一套新 UI。已知 429/服务端拒绝可有限重试，发送或编辑回执不确定时停止本轮任务且不自动重发。失败、中断、长度上限和空回复有状态提示；旧会话消息不会在新任务开始时重发。`/compact`、`/new` 确认及后端错误提示仍由程序直接发送。不增加 Telegram 工具/CLI、Activity 开关、多实例路由、正文草稿或连续工具合并。
  - 思考和工具参数会先遮蔽已知 token、Bearer、密钥/密码赋值形状，并阻止技术信息中的链接自动识别。**脱敏是尽力而为，并非完整的隐私过滤；思考和参数仍可能包含敏感信息。折叠和 Rich 排版需要 Telegram 客户端支持，实际效果需部署后验收。**
- **Telegram**：Secrets 中的 bot token；校验 webhook Secret，仅接收 owner 的私聊文本；按 update ID 去重、长回复拆分、持久化发送回执。群聊、编辑消息、媒体消息忽略。
- **Web Access**：按 `pi-web-access` 0.42.0 对齐搜索与网页读取的核心接口，不引入其 Node/浏览器后端。模型收到带来源链接的可读搜索结果或网页正文，而不是底层 JSON。
  - `web_search({query?, queries?, numResults?, provider?})`：单条或批量查询，每条最多 300 字符；结果数默认 5、最多 20。`provider` 支持 `auto`、`exa`、`brave`、`tavily`，省略或 `auto` 使用服务端配置（本项目配置为 Exa，未配置时仍为 Brave）。Exa 使用固定 HTTPS 接口的 `auto` 搜索并读取 highlights。需要所选服务对应的 `EXA_API_KEY`、`BRAVE_SEARCH_API_KEY` 或 `TAVILY_API_KEY` Secret，不自动切换或回退到其他付费服务。
  - `fetch_content({url?, urls?, mode?})`：只读取公开 HTTPS 的 HTML、文本、JSON。`readable` 为默认模式，提取可读纯文本；`raw` 保留文本响应体，不执行 HTML 或脚本。仍限制响应为 1 MiB、正文为 24,000 字符；截断明确标记，不虚构完整内容缓存或分页入口。
  - 批量最多 4 项、每批最多并发 3 项；列表参数优先，去除首尾空白并去重；部分失败保留成功结果，全部失败标记工具错误，取消会中止网络请求并阻止后续批次。批量搜索会按查询次数使用搜索 API。URL/DNS/重定向检查、域名白名单及错误脱敏保留，搜索结果的来源 URL 同样受校验。
  - 不提供缓存分页、PDF/视频、GitHub 克隆、浏览器 Cookie、代理、摘要生成或自动付费回退；未实现的参数会被拒绝。旧 `web_fetch` 工具名和 `count` 参数不再提供，现有 Skill 若写死旧接口，需要同步修改。
- **文本转语音**：`telegram_speak({text})` 调用 OpenRouter Seed 语音模型，直接生成 MP3 并以 Telegram 语音消息发送给 owner。使用说明作为 `skills/telegram-speech/SKILL.md`，模型通过 bash 按需读取；默认提示词只含 Skill 简介，不加载正文。用户任务初始化时仅在该文件不存在时补齐，不覆盖已有内容或 ETag；路径冲突或文件配额已满时跳过并记录日志，不阻断对话。语音生成不使用 ffmpeg、just-bash、公开文件 URL 或 R2；输入语音和转录仍不支持。

模型工具仅有 `bash({command, timeout?})`、`web_search`、`fetch_content`、`telegram_speak`；定时任务开始时不加载语音工具，收到真实用户输入后才为该请求提供语音能力。

本机 `~/.zshrc` 中的 `EXA_API_KEY` 不会自动成为 Worker binding：本地开发需写入不受版本控制的 `.dev.vars`；线上需另行执行 `pnpm exec wrangler secret put EXA_API_KEY` 后部署。密钥不写进 `wrangler.jsonc`、提示词或虚拟 bash 环境。未设置 `WEB_SEARCH_PROVIDER` 的调用方仍沿用 Brave，以兼容原配置。

应用系统提示词只注册一个 `conversation` 分段：用户记忆、Skill 简介，以及自动投递、时间语义、用户格式要求和授权边界等必要事实。bash 环境与文件路径在工具说明中描述；叫醒流程在定时任务输入中描述；Skill 正文按需读取。提示词不加入动作示例、重复否定、通用优先级训诫或针对过去模型失误的补丁；过时或冲突的信息在其来源修正，不追加提醒来补救。已有会话无需 `/new`；服务端安全校验、时间出站过滤和记忆加载机制不变。

`PI_MODEL` 直接传给 OpenRouter，不加载 Pi 内置模型目录，也不预先请求模型列表；未配置时默认 `xiaomi/mimo-v2.6-flash`，模型 ID 是否可用由 OpenRouter 判断。Pi 所需的模型描述固定为当前模型适用的 1,048,576 token 上下文，输出上限为 80,000 token（包括模型计入输出的思考 token）；切换到更小窗口的模型时需同步调整 `src/pi/models.ts`。不维护本地价格表，Pi 的费用估算置零（不表示免费），实际收费以 OpenRouter 为准。

模型思考启用 `thinkingLevel: "medium"`，在现有会话上生效，不清空历史或记忆；OpenRouter 请求使用 `reasoning.effort: "medium"`。这可能增加延迟和 token 费用，仍只展示 provider 实际返回的可见思考。

持续任务会使 Durable Object 保持活跃并产生运行费用。通用队列恢复 Alarm 每分钟检查运行中的任务；部署或进程重启时 bash 执行栈不会保存，Pi 会收到中断结果并在同一持久化对话继续，未完成的 bash 不会自动重放。单任务总时限为 6 小时。

