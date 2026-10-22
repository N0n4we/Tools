# MQTT 测试参考片段

Python 标准库实现的 MQTT 3.1.1 小工具与自检，只包含通用代码，不包含部署地址、凭据或压测结果。
这些片段不是完整 MQTT SDK，也不是已经验证过容量上限的整场压测器。

## 文件

| 文件 | 用途 |
| --- | --- |
| `mqtt_failures.py` | 通过 TLS 使用随机错误密码探测 CONNACK，区分 TCP、TLS 和 MQTT 错误 |
| `mqtt_hold.py` | 保持单条 TCP 连接，记录登录及心跳，不自动重连 |
| `mqtt_packets.py` | 报文编码、异步读取，以及非保留 QoS 1 PUBLISH 字段解析 |
| `disconnect_modes.py` | 直接 FIN、直接 RST、MQTT 静默及 TCP 双向 DROP 片段 |
| `test_*.py` | 仅使用 mock 或内存流的离线自检 |
| `env.example` | 保留地址，不指向真实服务的配置模板 |

旧的一次性压测脚本和运行资料留在本地忽略目录中，不纳入公开范例。
尤其不要复用“任意客户端超时就立即释放全场”的策略来证明服务端主动断线。

## 离线验证

```sh
uv run --no-project python -B -m unittest -v
```

不连接外部服务，不修改防火墙，不需要 root。断连单元测试验证调用顺序和规则文本，不证明实际报文类型。

## 连接探测

先把 `env.example` 复制为被忽略的 `env`，自行填写明确授权的目标和用户名：

```sh
cp -n env.example env
# 编辑 env 后再运行；不要提交 env。
uv run --no-project python mqtt_failures.py --config env
```

探测 30 次、约每秒发起一次；单次 TCP/TLS/MQTT 共用 1.5 秒期限。
系统 CA 校验服务端证书；每次生成随机错误密码，不读取真实密码，不发布或订阅。
意外认证成功时停止。进程退出码表示探测流程是否完成，**不能把它直接当作认证拒绝或网络封禁成立的证明**。
必须查看 JSON Lines 中每次探测的状态和 CONNACK 返回码；TCP 超时本身不能定位封禁或云平台故障。

## 单连接心跳观察

```sh
export MQTT_USERNAME='example-user'
export MQTT_PASSWORD='replace-locally'
uv run --no-project python mqtt_hold.py --host broker.example.invalid --port 1883 observation-1
```

替换为自己授权的目标。1883 是明文 TCP，不包含 TLS/WebSocket。
每个实例只保持一个唯一 Client ID；Keep Alive 为 20 秒，每 5 秒发 PINGREQ，响应期限 10 秒。
`pingresp` 才表示本次心跳收到回应；`ping_sent` 不证明服务端已收到。
EOF、协议错误或超时会退出该进程，不重连，不干预其他进程。

**Ctrl-C 或异常退出只关闭 TCP，不发送 MQTT DISCONNECT，也不保证最终一定是 FIN。**
它用于观察已有连接，不是优雅释放连接的模板。

## 关闭和静默模式

以下代码假设调用者已经建立 `asyncio` TCP 的 `reader`、`writer`，并自行管理发布、心跳和读取任务。
同一个 `reader` 同一时间只能由一个协程消费。代码段不替调用者建立或批量释放连接。

### MQTT 正常断开

先停止新发布，保留 MQTT 读取，确认期望的 PUBACK、投递等状态完成，再执行：

```python
writer.write(b"\xe0\x00")  # MQTT 3.1.1 DISCONNECT，没有服务端应答包。
await writer.drain()
writer.close()
await writer.wait_closed()
```

`drain()` 只处理本地发送缓冲的背压，不等待 TCP ACK，也不代替等待 MQTT PUBACK。
`wait_closed()` 不能作为对端收到了 DISCONNECT 或 TCP 四次挥手已完成的证据。
发送 DISCONNECT 后不再发送其他 MQTT 报文；TCP 关闭和重传由操作系统处理。

### 直接 TCP FIN

```python
from disconnect_modes import tcp_fin

tcp_fin(writer)  # write_eof()：写半关闭，不发送 MQTT DISCONNECT。
try:
    while await reader.read(65536):
        pass  # 保留读取直到对端 EOF。
finally:
    writer.close()
    await writer.wait_closed()
```

用于普通 TCP；不要把 TLS/WebSocket 的关闭行为混进来。等待有上限时，应记录超时，不能把强制清理冒充正常完成。

### 直接 TCP RST

```python
from disconnect_modes import tcp_rst

tcp_rst(writer)  # Linux：启用零秒 SO_LINGER，然后 abort；不发送 MQTT DISCONNECT。
```

对已建立的测试连接使用；实际出站报文必须通过抓包核验，不能只凭调用日志断言成功。

### MQTT 静默，TCP 仍接收

```python
from disconnect_modes import mqtt_silent

# 先停止该连接的发布、心跳和原 MQTT 读取任务，但不关闭 socket。
await mqtt_silent(reader)  # 持续消耗 TCP 字节，不解析或回复 MQTT。
```

接收到的 QoS 1 PUBLISH 不回 PUBACK，也不发送 PINGREQ；TCP ACK 仍由内核处理。
持续读取是为了避免缓冲填满后进入零窗口。启用 MQTT Keep Alive 时，服务端仍会因 MQTT 不活跃而超时关闭。
这不等于 TCP 网络黑洞，也不保证 TCP 层绝无丢包或重传。

### TCP 静默失联

```python
from disconnect_modes import drop_rules

rules = drop_rules(
    "mqtt_demo", "192.0.2.10", ["198.51.100.20"], [40001, 40002], port=1883,
)
```

以上仅生成规则字符串，不安装规则、不执行命令。IP 为文档示例，不能照抄为真实测试参数。

在明确授权的 Linux 测试机上，调用者应：

1. 从已建立连接获取实际本地 IP、源端口及目标 IP，使用本轮唯一表名。
2. 用 `nft -c -f <规则文件>` 校验，再显式安装规则；不得替换已有表或使用 `flush ruleset`。
3. 保留旧 socket，停止其 MQTT 工作；规则同时丢弃数据、ACK、FIN、RST，才是 TCP 层失联。
4. 规则匹配给定源端口与目标 IP 的组合；确保这些旧端口不用于本轮其他连接，重连不得复用旧端口。
5. `finally` 中先在 DROP 生效期间清理旧 socket，再删除自己创建的表；异常退出还需要外部回滚保障。

集合成员有 **30 分钟有效期**，到期后不再阻断，不能把它当作无限静默。
本片段没有实现安装、抓包、重连或 watchdog；不要未经补齐清理措施就直接用于远程压测。

## 在途消息和重传的核验边界

- QoS 1 在途：记录已经收到的 PUBLISH 及其 Packet ID，故意不回复 PUBACK，再注入故障；不等于 TCP 未 ACK。
- MQTT 重发：同 Packet ID、DUP=1 的 PUBLISH 作为新字节写入 TCP，不会仅因内容重复就计为 TCP 重传。
- TCP 重传：发送端重发已有 TCP 序号范围的数据或 FIN；需要数据包、ACK、序号和时间线证据。
- 只抓 FIN/RST 能检查关闭类型，**不能解释 TCP 数据重传峰值**。
- 发布计数、PUBACK 计数、去重投递数、当前在线数应分别记录；累计建连成功数不等于当前在线数。
- 不要把有在途消息时的客户端主动清理解释为服务端主动掉线，也不要把失败清理标记为完整测试成功。

抓包、四元组、主题、Client ID 和日志均可能暴露环境信息，只保存在被忽略的本地运行目录，不能随源码公开。
