# MQTT 连接失败测试

```sh
cd ~/Desktop/Tools/mqtt-test
uv run --no-project python -m unittest -v
uv run --no-project python mqtt_failures.py
```

读取同目录现有 `env` 中的 `ADDRESS`、`MQTT over TLS/SSL Port`、`Username`。
使用系统 CA 验证 TLS，**不使用真实密码**，每次生成错误密码，不发布或订阅消息。
30 次连接约每秒发起一次，每次 TCP/TLS/MQTT 总超时 1.5 秒；意外认证成功时提前停止并返回非零。
输出 JSON Lines，包含 UTC 时间、目标地址、本机源端口、MQTT CONNACK 返回码及汇总；不输出凭据。

- `application_rejected` 且返回码 4/5：MQTT 认证/授权拒绝，TCP/TLS 已连通。
- `tcp_timeout`：TCP 未建立，**仅凭超时不能认定是 AWS ACL 拒绝**；需同时核对 ACL 和 Flow Logs。
- `tls_error` / `mqtt_closed_without_connack`：其他阶段失败，不能当作 AWS 封禁成功。

Flow Logs 只描述网络流。认证失败通常仍是 `ACCEPT`，不能触发当前按入站 `REJECT` 包数检测的封禁脚本。
等待 S3 交付后再核对时间窗口和源 IP；不能通过手工预先封禁测试 IP 来证明检测算法有效。
`env` 和下载日志仅保留本机，不提交版本库。
