# pi-workbuddy-connect

将已登录的 WorkBuddy / WorkBuddy AI 桌面应用里的模型接入 [Pi](https://pi.dev)；两个版本各自分组，沿用各自的账号登录与积分。

## 安装

前置条件：本机已安装并登录 WorkBuddy（国内版）或 WorkBuddy AI（国际版）桌面应用。扩展直接读取 App 的登录状态，账号切换自动跟随。

```sh
# 从 npm 安装
pi install npm:pi-workbuddy-connect

# 或从 GitHub 安装
pi install git:github.com/gray0128/pi-workbuddy-connect

# 本地开发时从目录安装，或只对本次运行生效
pi install /path/to/pi-workbuddy-connect
pi -e /path/to/pi-workbuddy-connect
```

重启 Pi 后，`/model` 中出现 `workbuddy`（国内版）与 `workbuddy-ai`（国际版）两个分组；只装一版就只出现对应分组。选中一个模型完成一次对话即表示安装成功。

## 工作方式

扩展注册两个普通模型提供方，请求直接发往 WorkBuddy 网关，不经过本地代理：

- **模型目录**：读取桌面产品自身的 `/v3/config` 文档，取出 `cli` agent 的模型清单，并与文档中可用行取交集。网关按 User-Agent 分流，因此国内版使用 CLI 形态、国际版使用 `WorkBuddyAI/<版本>` 形态，拿到的都是本客户端身份可以对话的那份清单。在线列表以替换方式生效，上游下架的模型不会留在选择器里；拉取失败时保留上一次已知列表。
- **凭据**：读取桌面 App 自己的 auth 文件；扩展只在 Pi 的 agent 目录里保存刷新后的副本，从不写入 App 的文件。桌面文件与副本归属同一账号时取过期更晚者，账号切换后以桌面文件为准。
- **加密凭据**：WorkBuddy 5.6 起 token 字段在磁盘上加密。扩展以 `ELECTRON_RUN_AS_NODE=1` 运行 App 自带的 Electron，取 at-rest 密钥后用 AES-256-GCM 解开；密钥只留在内存。
- **令牌刷新**：仅在访问令牌进入过期前 5 分钟窗口时刷新，并发请求共享一次刷新；刷新失败但旧令牌仍有效时继续使用旧令牌。
- **请求兼容**：网关要求 `stream: true`、拒绝 `developer` 角色、拒绝 `reasoning_effort: "off"`，国际版还要求首条消息为 `system`。这些差异在请求发出前统一修正。

流式输出、工具调用、图片输入、取消与重试都由 Pi 自带的 OpenAI-compatible 实现负责。

## 命令

```text
/workbuddy            登录状态、目录来源与模型数
/workbuddy models     逐条列出模型（上下文、输出上限、图片、推理档位）
/workbuddy credits    当前账号剩余积分（每次读取都是一次真实计费查询）
/workbuddy refresh    重新读取凭据与模型目录，并让 Pi 重新发布模型列表
```

登录过期、切换账号或刚在 App 里完成登录后，先执行 `/workbuddy refresh`，通常不需要重启 Pi。

## 推理档位

只有上游在目录中声明了可选档位的模型才提供档位选择，声明值原样映射到 `reasoning_effort`。扩展不推断未声明的档位：这类模型的可用档位属于客户端私有逻辑，猜出来的值可能被上游静默忽略。

不提供 `Off`：唯一能表达"关闭思考"的写法是 `reasoning_effort: "off"`，网关以 HTTP 400 / code 11133 拒绝；省略该字段才是各处都验证可用的形式。选择默认档位即等同于省略。

## 已知限制

- 在 macOS 上验证（Pi 1.3.0）。Linux 与 Windows 的 auth 文件路径已实现但未验证；自动定位 Electron 可执行文件目前仅支持 macOS。
- 国际版的模型目录来自 App 界面接口，属私有实现，上游改动可能使其失效；届时退回内置表，`/workbuddy` 会标明目录来源为 `built-in fallback`。
- 内置模型表是 2026-10-18 的抓取快照，仅用于首次拉取前和离线启动，不代表上游当前状态。
- 未声明的档位、企业账号积分接口与国际版企业账号路径均未做真机覆盖。

## 环境变量

| 变量 | 用途 |
|---|---|
| `WORKBUDDY_AUTH_FILE` | 指定国内版 auth 文件路径，覆盖平台默认位置 |
| `WORKBUDDY_AI_AUTH_FILE` | 指定国际版 auth 文件路径 |
| `WORKBUDDY_ELECTRON_BIN` | 指定国内版 Electron 可执行文件，用于解密凭据 |
| `WORKBUDDY_AI_ELECTRON_BIN` | 指定国际版 Electron 可执行文件 |
| `PI_CODING_AGENT_DIR` | Pi 的 agent 目录，扩展的凭据副本写在这里 |

## 开发

```sh
npm install
npm test          # node --test，直接运行 TypeScript
npm run typecheck
```

`src/` 按职责拆分：`variants.ts` 存放两版之间的全部差异，`auth.ts` 与 `desktop-credential.ts` 负责凭据，`upstream.ts` 负责目录、刷新与积分，`payload.ts` 修正请求体，`models.ts` 把目录翻译成 Pi 的模型描述，`index.ts` 组装并注册一个原生 provider，在线目录整表替换启动时的内置表。

测试用 `node --test` 直接运行 TypeScript，覆盖目录解析、凭据合并与刷新策略、加密信封、请求体归一，以及一次真实的本地 HTTP 往返（验证 `stream`、`max_tokens`、无 `developer` 角色、档位映射）。

## 许可

MIT
