# Pi Durable Telegram Agent · Cloudflare Workers

单用户 Agent 后端，使用 `@earendil-works/pi-durable`，不启动容器。对外只开放 `POST /telegram/webhook`，校验 webhook Secret；不提供健康检查或管理 API。

## 功能

- 对话：注册 Telegram Bot 到此 Worker 的 webhook，
- `/compact`：owner 在私聊发送此命令后，按现有串行队列执行 Pi Durable 上下文压缩并回复结果，不把命令交给对话模型。默认保留最近约 20,000 token；上下文较短时回复无需压缩。历史记录和记忆文件保留，摘要生成会产生模型费用。
- 叫醒：每天北京时间 08:00 开始，每 2 分钟提醒，用户明确表示清醒后停止，最长持续 6 小时。模型每轮任务获得北京时间（Asia/Shanghai，UTC+8），定时提醒明确要求起床，不因 UTC 时间或历史睡觉话题改成睡觉提醒。

压缩任务 ID 会持久化，以便重启后继续等待原任务；创建任务与保存 ID 之间的崩溃窗口可能重复生成摘要，不删除历史记录。

## 流程图

```text
Telegram webhook
          │
          ▼
每个 TELEGRAM_USER_ID 一个 Durable Object
  串行队列 → Pi Durable → OpenRouter
                    ├─ Hermes / Skills / bash → 本 DO 的 just-bash 文件系统
                    ├─ Web Access      → HTTPS / Brave / Tavily
                    └─ telegram_speak  → OpenRouter MP3 → Telegram sendVoice
  持久化发件状态 → Telegram sendMessage
  Alarm → 可取消的唤醒提醒
```

## 工具调用

- **Hermes 文件功能**：读取、追加、纠正 `MEMORY.md`、`USER.md`、`failures.md`、可选 `STANDING.md`；关键词/中文子串检索；保存/读取嵌套 `skills/**/SKILL.md` 及参考文本。与 bash 共用 `@stablemodels/durable-bash` 的 SQLite 文件表，路径为 `/hermes/<TELEGRAM_USER_ID>/`（可通过 `MEMORY_PREFIX` 调整）。文件工具更新在同步事务内检查 ETag；bash 写入、复制、移动或重建文件同样使旧 ETag 失效。不是向量检索。
- **bash**：现有 Agent DO 继承 `FsObject`，通过 `DurableFs` 接入 just-bash，无需新增 DO binding。支持内置文本命令、管道、重定向和 shell 脚本；所有文件持久化，环境变量和工作目录每次重置。默认超时 30 秒，最多 60 秒；取消后阻止后续文件操作。单文件上限 256 KiB，记忆命名空间最多 2,000 个文件（含 bash 创建的文件）；输出由 Pi 截断。不给 shell 注入部署密钥，也不开启网络；网页访问仍使用现有 Web 工具。不是完整 POSIX shell：当前 just-bash 仅展开路径最后一段的通配符，durable-bash 的硬链接是内容快照，不共享后续修改。
- **Telegram**：Secrets 中的 bot token；校验 webhook Secret，仅接收 owner 的私聊文本；按 update ID 去重、长回复拆分、持久化发送回执。群聊、编辑消息、媒体消息忽略。
- **Web Access**：`web_fetch` 提取公开 HTTPS 的 HTML/文本/JSON；`web_search` 使用 Brave 或 Tavily。搜索需要对应 API Secret，网页读取不需要搜索服务密钥。
- **文本转语音**：`telegram_speak({text})` 调用 OpenRouter Seed 语音模型，直接生成 MP3 并以 Telegram 语音消息发送给 owner。语音流程不使用 ffmpeg、just-bash、公开文件 URL 或 R2；输入语音和转录仍不支持。

文件工具为 `memory_read/search/append/replace`、`skill_list/read/save`，虚拟 shell 工具为 `bash({command, timeout?})`，网页工具为 `web_search/fetch`，另有 `wakeup_confirm`、`telegram_speak`。

