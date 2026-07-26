# WebSocket 压缩弱网对照测试

该测试在 WSL2 中创建两个隔离网络命名空间：

- 服务端空间：运行真实游戏服务、24 个玩家负载和本地延迟探针。
- 客户端空间：运行一个观战客户端，通过独立 `veth` 链路连接服务端。

`tc netem` 分别作用于链路上下行，模拟延迟、抖动、限速和 TCP 包丢失。测试不会修改 Windows 主网络。

## 运行

在管理员 PowerShell 中执行：

```powershell
wsl.exe -u root -- bash "/mnt/c/3D射击游戏/scripts/ws-benchmark/run-wsl.sh"
```

快速冒烟测试：

```powershell
$env:BENCH_REPETITIONS = "1"
$env:BENCH_WARMUP_MS = "1000"
$env:BENCH_DURATION_MS = "3000"
wsl.exe -u root -- bash "/mnt/c/3D射击游戏/scripts/ws-benchmark/run-wsl.sh"
```

默认测试 6 种网络场景，每种压缩模式重复 3 次，每次预热 3 秒、采样 12 秒。

| 场景 | RTT | 抖动 | 每方向丢包 | 下行 | 上行 |
|---|---:|---:|---:|---:|---:|
| `lan` | 0ms | 0ms | 0% | 不限 | 不限 |
| `latency` | 200ms | 20ms | 0% | 5Mbps | 1Mbps |
| `good4g` | 100ms | 20ms | 0.25% | 2Mbps | 512Kbps |
| `weak3g` | 200ms | 50ms | 1% | 768Kbps | 256Kbps |
| `lossy` | 120ms | 30ms | 3% | 3Mbps | 512Kbps |
| `severe` | 400ms | 100ms | 2.5% | 256Kbps | 128Kbps |

输出位于 `reports/ws-benchmark/`：

- `raw.jsonl`：每次测试的原始指标。
- `summary.json`：聚合后的结构化结果。
- `report.md`：便于阅读的对照表。
- `server.log`、`bots.log`：故障排查日志。

测试进程被中断时，脚本会终止子进程并删除本次创建的网络命名空间。
