# 参与开发

## 跑起来

```bash
git clone <repo-url> && cd capy-relay
npm install          # 只有测试需要（ws）
npm test             # 工具映射层 + 隧道协议，全部本地，不消耗额度
```

运行本身没有依赖，`node server.js` 直接就能跑。

## 目录

| 路径 | 职责 | 对应测试 |
| --- | --- | --- |
| `lib/oaitools.js` | Capy handler ↔ 标准 function calling 的映射层：名字匹配、参数整形、结果整形、上限 | `npm run test:tools` |
| `lib/tunnel.js` | 设备 WebSocket 通道：流控窗口、credit、ping、关闭语义 | `npm run test:tunnel` |
| `lib/capy.js` | 建线程、读事件、回填工具结果 | — |
| `lib/clienttools.js` | 挂起调用与配对回填的中枢 | — |
| `lib/device.js` | 本机执行（bash / 读 / 写 / 编辑 / patch） | — |
| `server.js` | OpenAI 兼容层：请求校验、tool_choice、SSE、usage | — |
| `device-worker.js` | 设备端：invocation 注册表、长轮询、重连 | — |

## 改协议相关代码前

`lib/tunnel.js` 的规则是从客户端实现里逐条对出来的，改动前先读 README 的「设备通道遵守的协议」。
最容易踩的三个坑：

1. 数据帧 `streamId` 不能是 0，块长 1..65536。
2. 每收到一块要回**两条** `credit`（流级 + 连接级），少一条会发到 256KB 卡死。
3. 每 10 秒主动 `ping`，否则空闲被踢。

`npm run test:tunnel` 会在本地起假网关，把窗口、心跳、违规帧都验一遍，改完必须绿。

## 提交前

- `npm test` 通过。
- `git status` 里不该出现 `data/`、`config.json`、`*.log`、`*.zip`。
- 不要在代码里写死任何账号、org、device 标识或绝对路径；需要参数化就用环境变量（参考 `CAPY_BASH`、`CAPY_ORG_ID`）。
- 提 PR 时说清楚改的是哪一层（协议 / 映射 / 兼容层），附一条能复现的最小请求或日志片段。

## 不接受的改动

- 多账号轮换、绕过额度或限流。
- 把默认 `host` 改成 `0.0.0.0`、默认关闭 `localKey` 校验这类「方便但裸奔」的改动 —— 想对外用请写进文档让使用者自己开。
- 让服务端在共享端点下静默执行工具（`execMode: client` 时必须交还给调用方）。
