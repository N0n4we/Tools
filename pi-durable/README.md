# Pi Durable Telegram Agent · Cloudflare Workers

独立的单用户 Agent 后端，使用 `@earendil-works/pi-durable`，不启动 Pi CLI、容器或轮询进程。现有 `.github/workflows/telegram-{assistant,wakeup}.yml` 没有被修改。

**无 R2 版本**：只需要 Worker 和 SQLite-backed Durable Object，不创建 bucket，不需要为 R2 开通账单或绑定支付方式。[Workers Free 支持这种 DO](https://developers.cloudflare.com/durable-objects/platform/pricing/)，但有用量限制；模型和搜索服务仍独立计费。

## 当前部署

- Worker：<https://pi-durable-telegram-agent.story-botsfordli.workers.dev>
- Telegram：[@nonamestest_bot](https://t.me/nonamestest_bot)，已注册到此 Worker 的 webhook，仅允许 Secrets 中配置的 owner。
- 定时叫醒：北京时间每天 **06:00**（含周末），每 2 分钟提醒，用户明确表示清醒后停止，最长持续 6 小时；修改方法见“定时叫醒与修改时间”。
- 已完成真实云端模型调用和 Telegram 发送回执验证；文本检索、Skill 保存/读取、实时公开网页抓取与 ETag 冲突保护也已在云端验收，使用独立的合成 reference 文件。
- **真实 Telegram 收发已通过**：owner 发送验收私聊，云端任务完成、取得 `sendMessage` 回执，owner 确认收到“Telegram 收发正常”；webhook 积压为 0。
- 重新部署后已校验 3 个合成文本文件的完整哈希/ETag、已完成任务与 Telegram 回执均保留，webhook 正常。`pnpm check`、包含真实目录只读调试的 79 项测试和 Wrangler dry-run 构建全部通过；定时事件测试覆盖叫醒启动、重复触发不重复启动、owner 回复确认后停止。验收元数据在忽略的 `.wrangler/*acceptance.json`，不含密钥或真实记忆正文。
- **已按 owner 明确授权导入真实 Hermes 文本目录**：9 个文件、58,983 字节，包括 `MEMORY.md`、`USER.md`、`failures.md`、5 个 `SKILL.md` 和 1 个 reference；逐文件校验哈希，源目录未修改，未覆盖云端冲突文件。数据库、隐藏文件、恢复文件、符号链接及本机 Secrets 不在导入范围。
- 真实云端模型已验收：`USER.md` 上下文加载、主记忆读取与检索、全部 5 个 Skills 及 reference 读取、合成 reference 的保存/更新与冲突保护、不存在 Skill 的明确错误。部署后真实文件哈希与版本均保留，模型测试未修改真实资料；Telegram 已发送仅含完成状态的导入回执。对应元数据在 `.wrangler/hermes-*-acceptance.json`，无正文。
- 没有修改旧 GitHub workflows、开通 R2 或设置支付方式。两条旧 workflow 当前仅手动触发，迁移后不要再为同一个 bot 启动旧轮询。
- `web_fetch` 可用；尚未配置 Brave/Tavily Secret，`web_search` 暂不可用。真实 Telegram 入站通过下方 `/api/telegram/latest` 核对，必须由 owner 在 Telegram 发送消息，不能用合成 HTTP Update 代替真实验收。
- `telegram_speak` 已部署并通过真实云端模型→OpenRouter TTS→Telegram `sendVoice` 验收：生成 89,487 字节 MP3，语音回执 `471`、文字确认回执 `472`；重复提交复用原任务/语音回执，全部现有文件版本和 9 个源文本哈希保持一致。110 项测试（含真实 Hermes 目录只读调试）、类型检查和 dry-run 构建通过。证明元数据在忽略的 `.wrangler/speech-acceptance.json`；API 接受上传不等同于用户试听确认。

## 功能与存储

```text
Telegram webhook / 管理 API
          │
          ▼
每个 TELEGRAM_USER_ID 一个 Durable Object
  串行队列 → Pi Durable → OpenRouter
                    ├─ Hermes 文件工具 → 本 DO 的文本文件表
                    ├─ Skills 工具     → 本 DO 的文本文件表
                    ├─ Web Access      → HTTPS / Brave / Tavily
                    └─ telegram_speak  → OpenRouter MP3 → Telegram sendVoice
  持久化发件状态 → Telegram sendMessage
  Alarm → 可取消的唤醒提醒
```

- **Hermes 文件功能**：读取、追加、纠正 `MEMORY.md`、`USER.md`、`failures.md`、可选 `STANDING.md`；关键词/中文子串检索；保存/读取嵌套 `skills/**/SKILL.md` 及参考文本。按文件路径保存原始文本，在 DO 的 `hermes_text_files` 表中使用 `hermes/<TELEGRAM_USER_ID>/` 命名空间。管理 API 和模型工具均访问同一个 DO；更新在同步事务内检查 ETag，拒绝覆盖并发修正。ETag 是每次写入变化的版本号，不是内容哈希。不是向量检索。
- **不是原生 Hermes 插件的直接加载**：用 Durable Extension API 重写所需文件功能，不加载 Hermes 的 SQLite/会话检索模块、自动归档/合并或本地 shell。**Cloudflare 底层仍是 SQLite**，存放 Pi 状态及独立文本文件表；没有原生 Hermes 数据库或真实落盘文件。文件工具、HTTP API 和本地目录导入接口保持不变。使用 SQL TEXT 而非 DO 的 `get/put` 单值存储，以保留 256 KiB 文件上限、不受其 128 KiB 单值限制。
- **Telegram**：Secrets 中的 bot token；校验 webhook Secret，仅接收 owner 的私聊文本；按 update ID 去重、长回复拆分、持久化发送回执。群聊、编辑消息、媒体消息忽略。
- **Web Access**：`web_fetch` 提取公开 HTTPS 的 HTML/文本/JSON；`web_search` 使用 Brave 或 Tavily。搜索需要对应 API Secret，网页读取不需要搜索服务密钥。
- **文本转语音**：`telegram_speak({text})` 调用 OpenRouter Seed 语音模型，直接生成 MP3 并以 Telegram 语音消息发送给 owner。不使用 ffmpeg、just-bash、公开文件 URL 或 R2；输入语音和转录仍不支持。
- **唤醒**：北京时间每天 06:00 的 Cron 或手动 API 开始，默认每 120 秒提醒、最长 360 分钟；用户确实清醒后由工具停止。内部定时提示无权确认清醒。用户回复会推迟下一次提醒并抑制过时提醒。

文件工具为 `memory_read/search/append/replace`、`skill_list/read/save`，网页工具为 `web_search/fetch`，另有 `wakeup_confirm`、`telegram_speak`。

`skill_read` 使用 `skill_list` 返回的 slug（不包含 `skills/` 前缀），可选 `file` 是相对路径，默认 `SKILL.md`。不存在的 Skill 文件返回明确的工具错误；真实存在的空文件仍正常返回，不会把“未导入/路径错误”描述为文件被清空。管理 API 的新文件读取仍返回空正文与 `etag:null`，以支持安全创建。

### Telegram 文本转语音

在 Telegram 发「请用语音说：你好，今天也要加油」，Agent 会调用：

```json
{"text":"你好，今天也要加油"}
```

工具名是 **`telegram_speak`**。唯一参数为非空 `text`，最多 1,000 字符；成功返回 `sent:true`、`messageId`、`bytes` 和 `format:"mp3"`。收件人固定为 Secret `TELEGRAM_USER_ID`，不允许模型指定聊天 ID、密钥或任意音频 URL。每个用户任务最多发送一条，普通文字回复依然自动发送；**不会自动把 06:00 叫醒改成语音**。

- 复用 Workers Secret `OPENROUTER_API_KEY`，无需新增语音密钥。默认模型 `bytedance-seed/seed-audio-1-0`，调用 speech API 时原样传入工具的 `text`，不自动追加音色提示。可在 `wrangler.jsonc` 的 `vars` 中设置非敏感的 `TTS_MODEL`，再重新部署。更换模型需自行确认它支持同一 speech API 和 MP3 格式。
- 固定调用 `https://openrouter.ai/api/v1/audio/speech`，显式请求 `response_format:"mp3"`；Telegram `sendVoice` 支持 MP3，直接 multipart 上传，不依赖 PCM 转码。TTS 限时 60 秒，音频最多 5 MiB，上传限时 20 秒；错误正文、密钥和二进制不会进入工具结果或日志。
- 同一请求的重复工具调用/重复入站不会再次合成或外发。语音发件记录只保存输入摘要、状态、大小和发送回执，音频仅在内存中暂存；朗读原文作为用户输入/工具参数仍保留在受保护的任务/Pi 会话记录中。任何失败均不自动重发；网络超时/崩溃后的不确定回执应先检查 Telegram，确认未收到后再提出**新请求**。任务 API 的 `speech` 字段可用于诊断。
- 仅在用户明确要求语音时使用；内部定时叫醒任务不注册语音扩展，不向模型提供此工具或专用提示。管理 API `/api/chat` 中若明确要求调用 `telegram_speak`，工具本身会发送语音，即便 `deliverToTelegram` 没有设置；该字段仅控制最终文字回复。此副作用仅允许可信管理客户端触发。
- 朗读文本会交给 OpenRouter 和语音提供方，按其服务政策处理并产生 TTS 费用；音频上传到 Telegram，不能视为端到端加密或完全免费的本地处理。未创建可公开访问的音频文件。
- 原有 `seed-audio-voice-to-telegram` Skill 保持原文；其 ffmpeg/本地文件步骤不在 Workers 执行，新工具提供不需要转换的等价发送路径。可读取该 Skill 后直接调用本工具，不代表其他依赖 CLI 的 Skill 已可执行。

### 文件隐私

- 文件在私有 DO 中保存，**不是公开的静态文件**。匿名调用文件列表、`MEMORY.md`、`USER.md` 或 Skill 管理 API 均返回 `401`；直接访问 `/skills/.../SKILL.md` 返回 `404`。文件响应设置 `Cache-Control: no-store`。
- Telegram 仅允许 Secrets 中配置的 owner 私聊，管理 API 仅允许持有 `AGENT_ADMIN_TOKEN` 的客户端。不要分享这个 token；持有它的人能读取完整资料。
- 这不是端到端加密：Cloudflare 为 DO 提供平台静态加密，有相应账号权限的运维人员可以访问数据。相关记忆、用户资料和读取到的 Skills 会在模型请求中交给 OpenRouter 及其实际模型提供方，隐私与保留策略受这些服务约束。
- 不把正文或 Secrets 写入仓库、验收日志或本地证明文件；模型测试产生的回答保存在同样受保护的云端任务/会话中。Skills 的文本可读与持久化不意味着 Workers 可以运行其中依赖真实 shell、ffmpeg、语音或本地文件系统的步骤。

## 本地启动

需要 Node.js ≥ 22.19、pnpm。以下操作只影响本地：

```sh
cd /Users/yingtiankai/Desktop/Tools/pi-durable
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入自己的配置；不要提交这个文件。
pnpm dev
```

`pnpm dev` 明确使用 `wrangler dev --local`，DO 数据留在 `.wrangler/state/`。开发时若使用真实模型密钥，调用模型依然会访问 OpenRouter 并产生其费用；本地测试不会。生产 Secrets 不会自动从 GitHub Secrets 继承。

必须配置：

| Workers Secret | 用途 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather 的 bot token |
| `TELEGRAM_USER_ID` | 允许的私聊用户 ID，正安全整数 |
| `TELEGRAM_WEBHOOK_SECRET` | 随机 webhook Secret，建议 32 个十六进制字符 |
| `OPENROUTER_API_KEY` | 对话模型与文本转语音服务密钥 |
| `AGENT_ADMIN_TOKEN` | 随机管理 token，至少 32 字符 |
| `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` | 可选，选择一种搜索服务 |

`wrangler.jsonc` 的非敏感变量：`PI_MODEL`（默认 `xiaomi/mimo-v2.6-flash`，必须在固定版本 Pi 的模型目录中）、`MEMORY_PREFIX`（默认 `hermes/`，文件表命名空间前缀）、`WEB_SEARCH_PROVIDER`（`brave` 或 `tavily`），可选 `WEB_ALLOWED_HOSTS`（逗号分隔；`example.com` 精确匹配，`.example.com` 仅匹配子域）。改变 `TELEGRAM_USER_ID` 会选择另一个 DO，改变 `MEMORY_PREFIX` 会选择另一组记忆；旧数据不会自动迁移或删除。

### 调试已有 Hermes 目录

```sh
# 只显示路径和大小，不显示内容、不写文件、不上传。
pnpm memory:inspect --source /Users/yingtiankai/workspace/pi-hermes-memory

# Worker 已在本地运行，环境变量的值需与 .dev.vars 一致。
export AGENT_ADMIN_TOKEN='你的管理token'
pnpm memory:import --source /Users/yingtiankai/workspace/pi-hermes-memory \
  --url http://127.0.0.1:8787
```

导入保留目录结构，不修改源目录；忽略数据库、隐藏文件、锁、恢复文件和符号链接，只接收主记忆和 Skill 文本。相同文件跳过，不同的现有文件默认拒绝覆盖；只有明确提供 `--overwrite` 才尝试以读到的 ETag 更新，过程中再次变化仍拒绝覆盖。导入非事务性，失败前已成功的文件会保留，可安全重新运行。远程导入另需 HTTPS 和 `--allow-remote`，**不要未审查就执行**。

当前给定目录识别到 9 个文本文件、5 个 Skills，包含嵌套 reference。本地集成测试会将其导入临时 DO 存储，重启运行时后校验哈希、检索和 Skill 元数据，并再次核对源文件未变；临时目录结束后清理，正文不写入仓库或测试日志。以前的 R2 数据不会自动导入，可从本地 Hermes 目录重新导入；本次没有删除旧数据或源文件。

## API

除 `/health` 和 Telegram webhook 外，所有 API 必须携带 `Authorization: Bearer <AGENT_ADMIN_TOKEN>`。不配置 CORS；管理 API 仅供可信客户端。

| 方法 / 路径 | 请求 / 返回 |
| --- | --- |
| `GET /health` | 进程健康，不检查 Secrets、模型或 DO 存储 |
| `POST /telegram/webhook` | Telegram Update；必须带 `X-Telegram-Bot-Api-Secret-Token` |
| `GET /api/telegram/status` | Bot 身份、owner 私聊就绪状态、webhook URL/积压数量/最近错误时间；不返回密钥 |
| `GET /api/telegram/latest` | 最近 Telegram 入站任务的 ID、状态、时间、发送回执和安全错误码；无消息正文，尚无任务时 `{job:null}` |
| `POST /api/telegram/webhook` | `{confirm:true}`；仅注册当前 Worker 域名，不丢弃积压消息；先停止旧轮询 |
| `POST /api/chat` | `{requestId,text,deliverToTelegram?}` → `202 {id,status}` |
| `GET /api/jobs/<id>` | 状态、回答 `parts`、安全错误码、文字发送回执；调用语音工具时还含 `speech` 状态/回执 |
| `GET /api/memory/files` | 文件路径、大小、ETag |
| `GET /api/memory/file?path=MEMORY.md` | `{path,content,etag}`；不存在时空正文与 `null` ETag |
| `PUT /api/memory/file?path=...` | `{content,etag}`；新文件 `etag:null`，更新传读取到的 ETag |
| `POST /api/wakeup` | 可选 `{maxMinutes,intervalSeconds}`；已进行的唤醒不会重复开始 |
| `GET /api/wakeup` | 当前唤醒状态 |
| `DELETE /api/wakeup` | 停止唤醒 |

```sh
curl http://127.0.0.1:8787/api/chat \
  -H "Authorization: Bearer $AGENT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"requestId":"demo-1","text":"请检索我的记忆，列出可用 Skills"}'

# 用返回的 id 查询 /api/jobs/<id>；默认不向 Telegram 发送 API 聊天回复。
curl http://127.0.0.1:8787/api/wakeup \
  -H "Authorization: Bearer $AGENT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data '{}'
```

同一个 `requestId` 相同输入返回原任务；不同输入返回 `409`。`pending/running/ready/sending` 为中间状态，`complete/failed` 为终态。队列最多 64 个待处理任务，生成超时 120 秒；模型失败仍尽可能向 Telegram 发送一次错误提示。任务记录和 Pi 历史目前不自动过期。

## 生产配置与重新部署

下面会修改远程资源，请确认账号、费用、备份和迁移范围后再执行：

1. 确认 `wrangler.jsonc` 的 Worker 名称和账号。已设置 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 时 Wrangler 会自动读取，无需再登录；否则使用 `pnpm exec wrangler login`。Token 需具备 Workers 部署权限，**不需要 R2 权限或 R2 开通步骤**。
2. 将上表的必需配置逐一放入 Workers Secrets，例如：

   ```sh
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm exec wrangler secret put TELEGRAM_USER_ID
   pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
   pnpm exec wrangler secret put OPENROUTER_API_KEY
   pnpm exec wrangler secret put AGENT_ADMIN_TOKEN
   pnpm exec wrangler secret put BRAVE_SEARCH_API_KEY
   ```

3. 本地验证后部署：`pnpm exec wrangler deploy`。新 DO 的 SQLite migration 已在配置中声明；文本文件表在 DO 初始化时自动创建，无需手工建库。Workers/DO 的免费额度不是无限制，超限会失败；OpenRouter 与搜索服务单独计费，不能保证整体免费或真实负载始终满足 Workers 免费 CPU 限制。
4. 导入生产记忆需显式 `--allow-remote`；本地 `.wrangler/state` 不会随部署上传。可用 `/api/memory/files` 和逐文件 GET 读取/备份文本。不要删除 DO 类、namespace 或存储目录来更新代码，否则会丢失其中的记忆和会话。
5. **先停止旧 Actions 或其他 `getUpdates` poller**，同一个 bot 不能同时轮询和使用 webhook。设置 webhook 的脚本默认只预览：

   ```sh
   pnpm telegram:webhook --url https://你的worker域名/telegram/webhook
   # 确认迁移后才执行下面一行；在本机临时环境变量中提供 token 与 webhook Secret。
   pnpm telegram:webhook --url https://你的worker域名/telegram/webhook --confirm
   ```

   脚本不丢弃 Telegram 的 pending updates；旧缓存/已处理消息游标不会导入新后端，切换时应检查积压消息。旧 Actions 的记忆归档也不会与 DO 自动双向同步。

   本机无法直连 Telegram API 时，可让 Worker 代为检查/注册 webhook，Bot Secret 不需要传给客户端：

   ```sh
   export WORKER_URL='https://pi-durable-telegram-agent.story-botsfordli.workers.dev'
   # AGENT_ADMIN_TOKEN 从本机受保护配置加载，不要放入仓库或日志。
   curl "$WORKER_URL/api/telegram/status" -H "Authorization: Bearer $AGENT_ADMIN_TOKEN"
   curl "$WORKER_URL/api/telegram/webhook" \
     -H "Authorization: Bearer $AGENT_ADMIN_TOKEN" \
     -H 'Content-Type: application/json' --data '{"confirm":true}'
   curl "$WORKER_URL/api/telegram/latest" -H "Authorization: Bearer $AGENT_ADMIN_TOKEN"
   ```

   owner 给 bot 发一条私聊消息后，最近任务应达到 `complete` 且 `sentIds` 非空；同时 webhook 积压应归零、没有新的错误时间。Telegram 上游操作失败时管理 API 返回 `502` 和安全错误分类，不透出服务端原始描述或密钥。

### 定时叫醒与修改时间

#### 起床触发与停止路径

```text
wrangler.jsonc：每天 0 22 * * *（UTC）
  → src/index.ts scheduled()
  → owner Durable Object POST /wakeup
  → 保存 active / deadline / nextAt / intervalMs，立即唤醒 drain()
  → 队列空且到提醒时间时 nudge() 创建 kind=wakeup 任务
  → process() → answer() → Pi Durable / OpenRouter 生成简短中文文字
  → TelegramBot.send() → Telegram sendMessage
  → schedule() 设置下一次 DO Alarm → alarm() → drain()
```

带管理鉴权的 `POST /api/wakeup` 是手动入口，进入同一个 `/wakeup` 流程。默认立即发第一条，之后每 120 秒提醒，最长 360 分钟；已有未过期的唤醒不会重复启动。提醒不是用户输入，不能自行确认清醒。

用户私聊 → webhook 校验 owner/Secret → `/enqueue` 保存 `kind=user` 任务；任何用户回复都会推迟下一次提醒，并取消比该回复早的待发提醒。模型判断用户明确清醒后调用 `wakeup_confirm`，后端额外验证它来自唤醒开始后的真实用户任务，随后将 `active` 设为 `false`。管理员 `DELETE /api/wakeup` 或超时也会停止；队列清空且唤醒关闭后删除 Alarm。

定时提醒始终走文字发送，不加载语音工具和专用语音提示，也不等待音频生成。用户主动要求语音仍使用独立工具。长期记忆、Skill 目录和会话历史仍正常加载，可能包含过去的语音相关资料；这些不是起床任务的音频生成要求，本次不删除用户资料。

旧 GitHub 路径独立于 Workers：`.github/workflows/telegram-wakeup.yml`（目前仅 `workflow_dispatch`）→ `.github/scripts/telegram-wakeup.mjs` → `.github/prompts/telegram-wakeup-start.md` / `telegram-wakeup-nudge.md`。已移除两份提示中的 voice clip 要求，保留文字提醒、每两分钟重提示、确认文件和确认后空闲五分钟退出逻辑；未修改 workflow YAML，也未启用旧轮询。

#### 时间配置

当前配置为**北京时间每天 06:00，包含周末**。时间在项目根目录的 `wrangler.jsonc` → `triggers.crons` 修改：

```jsonc
// UTC 22:00 = 次日北京时间 06:00
"triggers": { "crons": ["0 22 * * *"] }
```

Cloudflare Cron 为 **UTC**，格式为 `分钟 小时 日 月 星期`；北京时间减 8 小时，小时跨日时取模 24。

| 北京时间（每天） | `triggers.crons` 中的表达式 |
| --- | --- |
| 06:00（当前） | `0 22 * * *` |
| 06:30 | `30 22 * * *` |
| 07:00 | `0 23 * * *` |
| 08:00 | `0 0 * * *` |

只保留一个表达式，替换原值即可；若设置星期，注意北京时间跨日也会改变对应的 UTC 星期。删除 `triggers` 或改为 `"triggers": { "crons": [] }` 后重新部署可关闭每天自动叫醒；已启动的提醒需另用 `DELETE /api/wakeup` 停止。

修改后，在已加载 Cloudflare 账号/Token 的 zsh 终端重新部署：

```sh
cd /Users/yingtiankai/Desktop/Tools/pi-durable
pnpm check && pnpm test && pnpm exec wrangler deploy
```

现有账号凭据已放在 `.zshrc` 时，新开 zsh 终端即可加载。**无需重设 Telegram webhook、重传现有 Secrets 或导入记忆**；保持 Worker 名称、DO binding/class、migration 和 owner 配置不变，会保留云端会话与文件。`pnpm build` 仅 dry-run，不会部署。

Cron 修改在 Cloudflare 全网传播可能需要最多约 15 分钟。Cron 只开始唤醒，重复提醒使用 DO Alarm，不常驻等待或运行 shell；生成/发送需要时间，不能保证消息恰好在 06:00:00 到达。

## 验证

```sh
pnpm check
pnpm test
HERMES_DEBUG_DIR=/Users/yingtiankai/workspace/pi-hermes-memory pnpm test
WRANGLER_SEND_METRICS=false pnpm build
```

测试包括 Node SQLite 单元测试与真实本地 workerd/SQLite DO，**不提供任何 R2 binding**；覆盖版本冲突、256 KiB 文件、工具调用和重启恢复，以及 TTS 格式/大小校验、multipart 语音上传、重复调用去重和不确定送达不重试。Telegram、TTS、DNS、网页和官方 OpenRouter SSE 都用本地响应模拟，未批准的外网请求会被拦截。普通测试不读取真实记忆目录；只有显式 `HERMES_DEBUG_DIR` 才读取。`build` 是 Wrangler **dry-run**，不会部署。Node 22 的 SQLite 实验性提示仅来自测试，不是 Workers 运行时依赖。

Pi Durable npm `1.0.4` 尚未导出 upstream main 的 Cloudflare adapter；`src/pi/storage.ts` 实现其公开 portable SQLite 接口，不导入私有模块，已通过 workerd 持久化/重启测试。更新依赖时应重新检查官方适配器与工具 API。

## 限制与安全边界

- Skills 是持久化文本能力，不是可执行宿主：可保存脚本，但不能运行真实 bash、`uv`、`pnpm`、ffmpeg、解压或本地文件操作。无需 shell 即可完成 DO 文本文件操作和 HTTP TTS，因此没有引入 `just-bash`。支持文本生成语音发给固定 owner，不支持语音输入/转录、PDF、浏览器自动化、其他附件和任意收件人的外发消息工具。
- 文件限制为 256 KiB，每个记忆命名空间最多 2,000 个文本文件；达到上限仍可更新已有文件。系统提示只展示部分主记忆与 Skill 目录；完整正文可按需用检索/读取工具获取。搜索和列举大量 Skills 会增加 DO 读写与 CPU，建议保持小目录。
- 本地验证不能保证所有第三方 Pi CLI 扩展兼容；这里只验证重写的 Durable 扩展与所需文件功能。已完成的云端验收不等于整体免费或持续高负载保证，仍需监控模型费用和 Cloudflare 配额。
- 对网页执行 HTTPS/端口/凭据/公网 IP/域名检查、DNS 预检和逐跳重定向检查，限制大小和时间；服务密钥请求不跟随重定向。DNS 预检不能完全消除 DNS rebinding，较高安全要求应配置 `WEB_ALLOWED_HOSTS` 或使用可固定解析地址的可信代理。
- DO 由 Cloudflare 提供平台静态加密；**没有应用层加密，也不沿用旧 GPG passphrase**。模型会收到相关记忆，运维人员通过管理 API 也可以读取。不要将记忆正文、Secrets 或 `.dev.vars` 提交到仓库；导入 Skill 前检查是否夹带敏感内容。
- 入站任务/模型提交有持久化去重；Pi 将中断的非安全写工具标记为不可自动重放。Telegram 没有出站幂等键，不能承诺严格 exactly-once：明确的限流/API 拒绝可重试，网络超时或崩溃后不确定是否送达时标记 `telegram_delivery_uncertain`，不会盲目重发。该策略倾向避免重复，但可能漏发，需人工检查。
- 日志不记录记忆正文、用户消息或服务返回中的密钥；平台自身的请求元数据/可观测性仍需按自己的隐私要求配置。管理 token 只允许可信调用方使用，公网防滥用和数据备份/保留策略需另行配置。
