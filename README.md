# capy-relay

把你自己的 **Capy 账号**变成一个标准的 OpenAI 接口，供 ChatBox、Cherry Studio、Continue 等任何支持 OpenAI 协议的 AI 客户端使用。

`MIT` · `Node.js >= 20` · `零运行依赖` · 单机服务，默认只听 `127.0.0.1`

---

## 它能做什么

- **在其他 AI 客户端里用 Capy**：只要那个客户端支持「自定义 OpenAI 兼容地址」，就能接上。
- **完全不需要 Capy 客户端**：登录一次，用自己的账号直接注册一台设备，之后只跑本项目的两个进程。
- **本机私有服务**：默认只监听 `127.0.0.1`。
- **真流式 + 看得到思考**：`stream: true` 时走 Capy 的 realtime websocket 逐字转发，思考过程作为 `reasoning_content` 一并流出来，不是等整段生成完再一次性吐。

## 它适合谁

- 有自己的 Capy 账号，想在其他 AI 客户端里用的人。
- 想在编辑器插件、命令行 Agent、自建工具里调用的人。
- 只想在自己电脑上跑，不打算对外提供服务的人。

## 它不适合谁

- 需要稳定、可商用 API 的场景 —— 这是本地桥接，不是官方服务。
- 想对外公开成公共 API 的场景 —— 即便开了 `execMode: client` 让别人用，消耗的仍是你的账号额度，务必设 `localKey` 并只发给信任的人。

---

## 开始之前

| 需要 | 说明 |
| --- | --- |
| Windows 10 / 11 | 目前只提供 Windows 启动脚本 |
| Node.js 20 或更高 | 命令行执行 `node -v` 能看到版本号即可 |
| 一个 Capy 账号 | 普通账号即可，登录在浏览器里完成 |
| 一个浏览器 | 登录时要用：Edge 或 Chrome，脚本会自动找（找不到可以用 `CAPY_BROWSER` 指定路径） |
| 一台已绑定为执行端的机器 | 见下面的「第一次启动」；每天使用不需要 Capy 桌面客户端 |
| Git for Windows | 要让它执行命令就需要。装官方版即可（<https://git-scm.com/download/win>），程序会自动找：先看标准安装目录，再看 `PATH` 里的 git；也可以用环境变量 `CAPY_BASH` 手动指定 bash 路径 |

> 说明：设备身份由本项目自己注册（`POST /devices/enroll`，见 `lib/auth.js`），**不需要安装或运行 Capy 桌面客户端**。设备身份保存在 `data/device.json`，也可以直接把这个文件复制到另一台机器使用。

---

## 第一次启动（含登录）

拿到源码后（`git clone` 或解压 zip），进入目录：

```powershell
cd capy-relay
```

源码是纯 Node.js，**运行不需要装任何依赖**（`npm install` 只是给测试用的）。直接双击 `start.bat`，或在 PowerShell 里：

```powershell
.\start.bat
```

想先改配置：把 `config.example.json` 复制成 `config.json` 再改。不复制也能跑，程序内置了同样的默认值（端口 8787、只监听本机）。

它会先检查账号。没登录过就问一句：

```
   ---- 账号 ----
   这台机器还没有登录过 Capy 账号。

   请选择：

     1  打开浏览器登录   窗口里登进 capy.ai，登录完成后自动继续（推荐）
     0  退出

   输入 1 / 0 后回车：
```

选 1 之后会发生三件事：

1. 弹出一个**独立浏览器窗口**，地址是 <https://capy.ai>。这个窗口用的是独立配置（`data/browser-profile`），跟你平时用的浏览器互不干扰，也不读你的历史记录。
2. 你在里面**正常登录**——微软、谷歌、邮箱验证码，网页给什么入口就用什么。本项目不自己实现登录流程，也不收集密码。
3. 登进 Capy 主界面后，脚本把浏览器里的登录 cookie（Clerk 的 `__client`）接过来换成本地会话，然后自己把窗口关掉。

成功后，同一个脚本接着确认登录态和本机设备身份，然后起服务：

```
   [OK] 已登录：you@example.com
   [OK] 执行设备：device_01M7RQAJ5Q7ZWBWMVS…（本机）

[2/3] Starting device worker (window "capy-device", minimized)
[3/3] Relay on http://127.0.0.1:8787/v1
```

看到最后一行就成功了。它会拉起两个进程：

- **设备执行端**（后台小窗口，标题 `capy-device`）：让云端能把任务派到你这台机器。
- **接口服务**（当前窗口）：`http://127.0.0.1:8787/v1`

保持窗口开着；关掉窗口就等于停止服务。

> 设备身份会自动注册：用你的登录态调一次 `POST /devices/enroll`，把 `deviceId` + `capyd_…` 令牌存进 `data/device.json`。**全程不需要 Capy 桌面客户端**。想换一台新设备身份就 `node login.js enroll`，想接管本机客户端残留的旧身份才用 `node login.js adopt`。
>
> 登录态保存在 `data/auth.json`，长期有效，过期了下次启动会自动问你要不要重新登录。

### 浏览器窗口打不开，或者想用自己平时那个浏览器

还有两条备用路，都不用重新实现登录：

- **从你自己的浏览器粘 cookie**：在已登录 capy.ai 的浏览器里按 F12 → Application → Cookies，复制 `https://clerk.capy.ai` 下的 `__client`，以及 `capy.ai` 下的 `__client_uat`，然后：

  ```powershell
  node login.js cookie "__client=eyJ...; __client_uat=1700000000"
  ```

- **接管一个已经开着调试端口的浏览器**：`node login.js attach 9444`（端口按实际情况改）。

登录态失效（换过密码、在别处登出）时，`node login.js browser --fresh` 会清掉 `data/browser-profile` 重新来一遍。

---

## 日常启动

已经登录过就直接双击 `start.bat`，不再问，直接起服务。

- 想换账号 / 重新登录：`start.bat login`（还是会开那个浏览器窗口，登完自动接管）
- 提示端口被占用：说明上一份还在跑，先关掉那个窗口（连同最小化的 `capy-device`）再来
- 想跳过菜单、纯命令行登录：`node login.js`（等于 `node login.js browser`）

想确认状态，浏览器打开 <http://127.0.0.1:8787/health>：

```json
{
  "ok": true,
  "mode": "self-login",
  "tools": {
    "bash": true,
    "gitBashRaw": "C:\\Program Files\\Git\\bin\\bash.exe",
    "gitBashVia": "git-windows",
    "gitBin": "C:\\Program Files\\Git\\cmd\\git.exe"
  }
}
```

`mode` 是 `self-login` 表示正在独立运行；`tools.bash` 为 `true` 表示本机可以执行命令。

`gitBashVia` 说明这个 bash 是怎么找到的：

| 值 | 含义 |
| --- | --- |
| `git-windows` | 标准安装目录（`Program Files\Git`、`%LOCALAPPDATA%\Programs\Git`） |
| `path:git` | 从 `PATH` 里的 `git` 反推出与它配套的 bash |
| `path:bash` | 直接命中了 `PATH` 里的 bash |
| `env:CAPY_BASH` | 你自己用环境变量指定的 |

机器上装过多份 Git（比如同时还装着某个 IDE 附带的便携版）时，看这三个字段就知道实际用的是哪一份。

---

## 在 AI 客户端里怎么填

以 ChatBox 为例（其他客户端字段名类似）：

| 项目 | 填什么 |
| --- | --- |
| 提供商 | OpenAI API / OpenAI 兼容 |
| API 地址 | `http://127.0.0.1:8787/v1` |
| API 密钥 | 随便填，例如 `sk-local`（本机服务，不校验） |
| 模型 | 从下拉里选，或手动填，例如 `particle/particle-1` |

推荐先用 `particle/particle-1`：免费、1M 上下文、不需要额外额度。

---

## 给别人用：工具在对方电脑上执行

默认情况下命令跑在**跑服务的这台机器**上（自己用最省事）。把 `config.json` 改成：

```json
{ "execMode": "client" }
```

这时整套链路变成「把工具调用交还给调用方」：

```
模型决定执行 bash
  → 中转站不执行，把它翻译成标准 OpenAI tool_calls 返回
  → 调用方（ChatBox / 自己写的脚本 / 任何支持 function calling 的客户端）
    在它自己的电脑上跑这条命令
  → 把输出作为 role=tool 消息发回来
  → 中转站把结果灌回原来那条 Capy 线程，模型继续推理
  → 需要更多命令就再返回一次 tool_calls，直到模型给出最终回答
```

也就是说：**你的机器只当中转，命令一行都不在你的机器上跑**。可以用这条命令验证——
发一个让它写文件的请求，但故意不执行 tool_calls，然后在本机看文件是否存在：

```bash
curl -s localhost:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"particle/particle-1","messages":[{"role":"user","content":"用 bash 写一个 /tmp/x.txt"}],
       "tools":[{"type":"function","function":{"name":"bash","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]}'
```

只会拿到 `tool_calls`，本机不会出现那个文件。

三种模式：

| 值 | 命令在哪跑 | 适用 |
| --- | --- | --- |
| `local` | 跑服务的这台机器 | 自己用 |
| `client` | 调用方自己的电脑 | 开中转站给别人用 |
| `none` | 都不跑，只出模型 | 只想借用模型、不要执行能力 |

也可以在单次请求上用请求头临时覆盖：`X-Capy-Exec: client` / `local` / `none`。

调用方那一侧要注意：

- 客户端必须支持 **function calling**，并且会把 `role=tool` 的结果回传（ChatBox、Cherry Studio、LobeChat、手机上的各种 harness 都支持）。
- 一轮工具调用大约多花 8~15 秒（模型判断 + 你本机执行 + 云端把结果接回去），慢命令更久。客户端超时建议 ≥180 秒，并开启流式。
- 同一轮里模型并行发起的多条命令会一起交出去（最多 16 条），客户端需要按 `tool_call_id` 逐条回填。
- 某条调用客户端不回填也没事：中转站会把它判失败并告诉模型重发，不会让设备端干等到超时。

### 工具怎么对上号

Capy 的模型只认自己那套工具，工具清单在云端，请求里改不了。所以中转站做了一层翻译：
把 Capy 的 handler 映射成**调用方声明的那个工具**，名字和参数都按它的 schema 摆。

| Capy 调用 | 能承接的客户端工具名（都不区分大小写、下划线可有可无） |
| --- | --- |
| `bash` | `execute_command` `run_command` `run_shell_command` `shell_exec` `terminal` `bash` `exec` … |
| `read` / `file_read` | `read_file` `file_read` `view_file` `cat` … |
| `file_write` | `write_file` `file_write` `create_file` `save_file` … |
| `edit` | `edit_file` `replace_in_file` `str_replace_editor` … |
| `apply_patch` | `apply_patch` `patch_file` … |

不在表里的名字会按关键词兜底（名字或描述里含 command/shell/terminal/exec 就算命令类）。
参数键名也按对方 schema 走：它写 `cmd` 就发 `cmd`，写 `file_path` 就发 `file_path`。

**没声明的工具，中转站不会硬塞过去**——那条调用会在本机执行（`local` 语义），
名字对不上时对方只会回一个「未知工具」，反而更难查。

一个请求里一个工具都没声明时，中转站会**拒绝在服务端执行**并把这个原因回给模型，
而不是偷偷在你机器上跑（共享端点下这点很要紧）。

### tool_choice 与上限

| 参数 | 行为 |
| --- | --- |
| 不传 / `auto` | 模型自己决定，该调就调 |
| `none` | 一个工具都不外抛，模型真要调就在本机跑，最终只回文本 |
| `required` | 必须调工具；模型只给文本时会催一次，还不调就返回 `400 tool_choice_violation`，不拿文本冒充 |
| `{"type":"function","function":{"name":"X"}}` | 只放行映射到 X 的那类调用，其余交回本机执行 |

`parallel_tool_calls: false` 时一轮只发第一个调用，其余判失败。
上限：单轮最多 16 个调用、单请求最多 256 个工具定义、拼出来的对话最多 200 万字符（超了返回 `context_too_long`）。
流式请求带 `stream_options.include_usage` 时，最后会多一个只含 `usage` 的 chunk。

### 接手机 / 同一局域网

1. `config.json` 里 `host` 改成 `0.0.0.0`，并设一个 `localKey`（否则同网段谁都能用你的额度）
2. 防火墙放行端口（默认 8787）
3. 手机端把 API 地址填成 `http://<你电脑的局域网 IP>:8787/v1`，key 填 `localKey`

命令会跑在手机上，前提是那个客户端自己会执行 `tool_calls`。验证方法：让它执行 `whoami && uname -a`，
回的是手机的系统就对了；回 Windows 用户名说明命令跑到了你电脑上（配置没生效）。

`/health` 里 `toolMode` / `forwardable` / `limits` 三项能直接看到当前生效的形态。

自己先验证一遍闭环（会真的在你本机执行命令）：

```bash
node tools/sim-client.mjs "用 bash 执行 ls /d 看有哪些目录，再用一句话总结"
```

---

## 使用体验说明

- **一次提问 = 一个新线程**，跑完自动归档，不会把 Capy 侧栏塞满。
- **回答不是逐字蹦出来的**：首字通常要等 4~10 秒，复杂任务更久。这是「在本机真实执行」的代价。
- **每次提问是全新上下文**：多轮对话由你的 AI 客户端把历史一起发过来。
- **模型列表是客户端版本的快照**：跑一次 `npm run models` 可以刷新。
- **默认不显示工具细节**：它确实执行了命令，但回复里只有结论。想让回复末尾附带执行轨迹，在请求里加一行头 `X-Capy-Tools: 1`。

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `node login.js` | 打开浏览器登录（等同于 `browser`） |
| `node login.js browser` | 同上；加 `--fresh` 先清掉 `data/browser-profile` 再登 |
| `node login.js cookie "…"` | 从你自己的浏览器粘 `__client` / `__client_uat` |
| `node login.js attach [端口]` | 接管一个已开调试端口的浏览器（默认 9444） |
| `node login.js status` | 看登录是否还有效、设备是谁 |
| `node login.js enroll` | 用登录态注册一台新设备（不需要客户端） |
| `node login.js adopt` | 接管本机客户端残留的旧设备身份（可选） |
| `node login.js logout` | 清除本机登录态（设备绑定保留） |
| `node device-worker.js` | 单独启动设备执行端 |
| `node server.js` | 单独启动接口服务 |
| `node tools/sim-client.mjs "…"` | 模拟一个客户端跑完整工具闭环（会真的执行命令） |
| `npm run test:tunnel` | 用假网关跑协议一致性测试（22 项，含窗口/心跳/违规帧） |
| `npm run test:tools` | 工具映射层单测（44 项：名字匹配、参数形状、结果整形、上限） |
| `npm run test:login` | 登录层单测（13 项：cookie 解析、缺 cookie 的前置拒绝） |
| `npm test` | 上面三套一起跑 |

---

## 设备通道遵守的协议

`lib/tunnel.js` 按 Capy 客户端的实现逐条对齐，下面这些点漏一个都会被对端判成协议违规并断开：

| 规则 | 违反的后果 |
| --- | --- |
| 数据帧 `streamId` 不能是 0，块长 1..65536，不能为空 | 直接断开 |
| 两条流控窗口：连接级 2MB、单流 256KB，超了要等 `credit` | 对方 reset 这条流，大响应被截断 |
| `credit` 每块要回两条：流级 + 连接级 | 少流级那条 → 发满 256KB 后彻底卡死 |
| 先 `response` 才能发数据，发过 `close` 不能再发 | 判违规断开 |
| 对端开流用偶数 `streamId`（device 侧发起的才是奇数） | 流对不上 |
| 流关闭后要能容忍迟到的尾部数据帧 | 否则会被当成 unknown stream 违规 |
| 每 10 秒主动 `ping`，收到 `ping` 回 `pong` | 空闲超时被踢，表现为反复断连 |
| 控制帧序列化后 ≤ 65536 字节 | 断开 |

`npm run test:tunnel` 会起一个假网关，把上面这些逐条打分，包括「500KB 响应是否停在 256KB 等窗口」和「400KB 请求体能否靠 credit 收完」。

---

## 常见问题

| 现象 | 怎么办 |
| --- | --- |
| 启动时问「请选择」 | 正常，还没登录过；选 1 登录一次即可 |
| `Not signed in yet` | 先跑 `node login.js` 完成登录 |
| `已登录但还没有注册执行设备` | 跑 `node login.js enroll` |
| `本地登录会话已过期` | 重新跑一次 `start.bat login` |
| 登录窗口打开后一直显示「等待登录…」 | 确认已经在网页里登进 Capy 主界面（不是停在登录页），也不要中途关掉窗口 |
| 提示 `cookie 里的会话已经失效` | 浏览器里存着旧登录；`node login.js browser --fresh` 清掉重登 |
| 提示 `没有找到 Edge / Chrome` | 装一个，或用环境变量 `CAPY_BROWSER="D:\某处\chrome.exe"` 指定 |
| 不想开独立窗口 | `node login.js cookie "…"` 从你自己的浏览器粘 cookie |
| `/health` 里 `tools.bash` 是 `false` | 没找到 Git Bash。装 Git for Windows（勾默认的「Git from the command line」），然后**重开窗口**再启动，PATH 才会刷新 |
| 想指定用哪份 bash | 启动前设环境变量 `CAPY_BASH=D:\Git\bin\bash.exe` |
| 它说「这台机器跑不了命令」 | 同上；另外确认 `capy-device` 那个小窗口还在跑 |
| 选了模型却用不了 | 该模型需要付费额度，换 `particle/particle-1` |
| 回答特别慢 | 正常。建线程 + 本机执行本身就有几秒开销 |
| 端口被占用 | 已经有一个反代在跑，先关掉旧窗口，或改 `config.json` 的 `port` |
| 任务好像没落到本机 | 检查 `data/device.json` 里的设备是否还在账号下（`node login.js status`） |
| 通道每隔几十秒断一次，日志里是 `4002 displaced` | 同一台机器上还有别的程序在用这个设备身份（通常是 Capy 桌面客户端）。**关掉它**，或 `node login.js enroll` 给 relay 单独注册一个设备 |
| 日志里写 `账号被 Capy 暂停（capy/AccountSuspended）` | 登录是好的，是账号在 Capy 侧被限制。去 capy.ai 看提示或走支持渠道，恢复后这个窗口会自动连上 |

> 现场留不住的问题已经修了：设备端日志现在会同时写进 `data/logs/worker-YYYY-MM-DD.log`，出问题时把这个文件发出来就能定位。

---

## 需要注意

- **不要同时开 Capy 桌面客户端和 `capy-device`**：两者共用同一个设备身份，服务端只允许一条隧道，会互相顶下线（`4002 displaced`），一直抖。要么关客户端，要么 `node login.js enroll` 注册独立设备。
- 这是**本机自用**工具。默认不要改成对外监听（`0.0.0.0`）。真要给别人用，开 `execMode: client`（命令在对方机器上跑）并设好 `localKey` —— 额度消耗的仍然是你自己的账号。
- `data/auth.json`、`data/device.json` 和 `data/browser-profile/` 都等于你的账号凭据（最后一个是登着 capy.ai 的浏览器配置），**不要提交到 Git、不要发给别人**。项目已在 `.gitignore` 里排除 `data/` 和 `config.json`。
- 它依赖 Capy 的内部接口，对方升级后可能需要更新一次配置（模型列表）。
- 不是官方产品，不提供任何稳定性保证。

### 关于风险（说清楚）

这个项目没有使用任何公开 API：登录走 Clerk，任务走 `api.capy.ai/app`，设备通道是自己实现的 WebSocket 隧道。这些都是**客户端内部协议**，不是给第三方用的接口，因此：

- 可能违反 Capy 的服务条款，**账号可能被限制**（作者本人遇到过 `capy/AccountSuspended`，登录态还在，但 app 层 403）。
- 对方随时可能改协议，改了就断；仓库不承诺跟进时间。
- 别拿它做对外服务、别多账号轮换刷额度。想稳定用，去买官方 API。

出了这类问题本项目帮不上忙，也不承担后果。**自己想清楚再用。**

---

## 开发

```bash
npm install          # 只有一个测试用依赖（ws）
npm test             # 工具映射 44 项 + 登录层 13 项 + 隧道协议 22 项，都不需要联网、不碰你的账号
```

- 测试全部跑在本地假网关/纯函数上，不会消耗额度，也不会执行真实命令。
- 改了 `lib/oaitools.js` 就跑 `npm run test:tools`，改了 `lib/tunnel.js` 就跑 `npm run test:tunnel`，改了登录/cookie 相关就跑 `npm run test:login`。
- 提交前请确认 `git status` 里没有 `data/`、`config.json`、`*.log`。
- 详细约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可

[MIT](LICENSE)。随便改、随便发，保留版权声明即可。

非官方项目，与 Capy 官方无关。

