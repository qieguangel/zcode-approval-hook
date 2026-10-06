# zcode-approval-hook

用你自选的审批模型，自动完成 [ZCode](https://zcode.z.ai)（Z.AI 编码代理客户端）的权限审批弹窗。

ZCode 官方没有内置"AI 代批"：权限请求（运行命令、写文件等）默认永远等待人工点击。本项目利用官方 `PermissionRequest` hook 扩展点，把"本该弹窗"的审批请求交给一个便宜、快速的 LLM 判定——**ALLOW 自动放行，DENY 自动拒绝并给出理由**，让 Agent 连续干活不再被弹窗打断。

> 实测效果：工作区内文件编辑 **0ms 本地放行**（不调模型），普通命令约 1~1.5 秒完成自动裁决，危险操作（越界写入、装依赖、外发数据等）自动拒绝并附中文理由。

## 特性

- **零配置 key**：优先复用 ZCode 自身 provider 配置里已保存的 API key（按端点自动匹配），也可用环境变量或本地文件手填
- **模型一键切换**：配置文件里改一个 `active` 字段即可换审批模型（任何 OpenAI 兼容 `/chat/completions` 端点都行）
- **本地快路径**：只读命令白名单、工作区内文件编辑、git 本地备份操作——0ms 直接放行，不消耗模型调用
- **机械复核护栏**：模型以"路径越界"为由拒绝时，用本地路径比对证伪误判并推翻（工作区边界是可验证的事实，不交给模型"回忆"）
- **零挂起设计**：判定拿不准、API 超时/故障 → 保守拒绝并附理由，**不会出现"弹窗挂起等人"的卡顿**；唯一弹窗场景是审批服务未配置
- **不越权**：ZCode 官方的显式 deny 规则、Plan 模式写禁令不受 hook 影响；全部走官方 hook 扩展点，不修改客户端

## 工作原理

```
Agent 请求执行操作（会触发审批弹窗时）
   │  stdin: { tool_name, tool_input, cwd, ... }（JSON 一行）
   ▼
approval-hook.mjs（Node 同步进程 hook）
   ├─ 本地快路径命中（只读命令白名单 / 工作区内 Write·Edit / git 本地操作）
   │    → 立即输出 {"behavior":"allow"}（0ms，不调 API）
   ├─ 未命中 → 调用审批模型（OpenAI 兼容端点）做 ALLOW/DENY 二分类判定
   │    ├─ ALLOW → 输出 allow
   │    ├─ DENY → 若理由声称"路径越界"，先本地机械复核：证伪则推翻（boundary-override）
   │    │         确证越界 → 输出 deny + 理由
   │    └─ 拿不准 / 超时 / 网络失败 / 输出异常 → 保守 deny（附理由，立即返回）
   └─ 审批服务未配置 → 不输出 → ZCode 照常弹人工窗
```

## 安装（三步）

### 1. 把 `hook/` 目录放到一个稳定位置

比如复制到 `D:\tools\zcode-approval-hook\hook\`。**路径此后不要改名/移动**（hooks 注册的是绝对路径）。

### 2. 注册 hook 到 ZCode 用户级配置

编辑 `~/.zcode/cli/config.json`（Windows 即 `C:\Users\<你>\.zcode\cli\config.json`，没有就新建），加入：

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 120000,
    "events": {
      "PermissionRequest": [
        {
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["<hook 目录的绝对路径>/approval-hook.mjs"],
              "enabled": true,
              "timeoutMs": 120000
            }
          ]
        }
      ]
    }
  }
}
```

要点：

- **必须用户级**：工作区 `<repo>/.zcode/config.json` 里的 hooks 会被 ZCode 整体忽略
- **必须 `hooks.enabled: true`**（配置文件 hooks 默认不跑）
- Windows 上若 `node` 不在系统 PATH，用 node.exe 的绝对路径
- 省略 `matcher` = 接管所有审批弹窗（也可以用 `"matcher": "Bash|Write|Edit|WebFetch"` 收窄）

### 3. 完全重启 ZCode（配置不热加载）

保持权限模式在 **Ask before changes**（默认档），然后让 Agent 干活即可。若 ZCode 里已登录过某服务商（如 OpenCode Go），**key 通常无需任何配置**。

## 审批模型配置与切换

复制 `hook/approval-config.example.json` 为 `hook/approval-config.json`，把 `active` 改成想用的 provider id（改完重启 ZCode 生效）。任何 OpenAI 兼容 `/chat/completions` 端点都可以接入。

### key 解析顺序

1. 环境变量（provider 的 `apiKeyEnv` 字段）
2. `hook/keys.local.json`（从 `keys.local.example.json` 复制，**勿提交到 git**）
3. **ZCode 自身 provider 配置**（`~/.zcode/v2/config.json`，按 baseURL 的 host 自动匹配）——默认路径

想强制手填，给该 provider 加 `"keySource": "manual"`。

> 注意：自动发现依赖 ZCode 的内部配置文件结构（`provider.*.options.apiKey`），ZCode 版本升级若改动该结构，此项可能失效（届时用手填兜底即可）。另外 OpenCode Go 网关强制要求 `x-opencode-session` 请求头，缺失会报 400 `MissingSessionID`——已在示例配置的 `extraHeaders` 中带上。

### 选型建议

- 快而便宜优先（审批要 1 秒级返回）：各家 flash/light 档模型
- 已知实测参考：`deepseek-v4-flash` 约 1 秒/次、判定准确；更强的模型在审批这种二分类任务上提升有限但延迟明显增加
- 网关对连续请求可能限流（表现为超时后被保守拒绝，稍后重试即可）；批量测试时场景间留 1.5 秒间隔

## 判定逻辑

### 本地快路径（0ms，不调模型）

| 路径 | 条件 |
|---|---|
| `whitelist` | Bash 命令命中 `policy.bashWhitelist` 只读白名单（含 `;` `&&` `\|` `>` `$()` 等拼接符的命令一律不走白名单，防绕过） |
| `workspace-write` | `Write`/`Edit` 的 `file_path` 落在工作区内（本地前缀比对） |
| `git-local` | 单一 `git add/commit/status/log/diff/show/branch/tag` 命令，无 `--force`/`--hard` |

工作区根的确定：从 ZCode 传入的 `cwd`（以及 `ZCODE_PROJECT_DIR`）**向上搜索最近的含 `.git` 或 `AGENTS.md` 的目录**。这一点很关键——实测 ZCode 的 `cwd` 会随 shell 的 `cd` 漂移到子目录，直接拿它当边界会把项目内路径误判成"工作区外"（见故障案例 2）。

### 模型判定（约 1~1.5 秒）

二分类 prompt（`lib.mjs` 的 `buildUserPrompt`，可自行调整措辞）：

- **ALLOW**：工作区内的文件读写/编辑/删除；工作区内运行的构建、测试、脚本、git 操作；只读查看任意位置的日志/配置/文本文件
- **DENY**：写入/删除工作区外路径；删除系统文件；安装/升级依赖；修改系统配置/环境变量/注册表；破坏性 git 操作；外发本地数据；读取 `.ssh`/`.aws`/`.gnupg` 等凭据私钥

### 机械复核护栏（boundary-override）

模型拒绝且理由声称"路径越界"时，本地机械比对 `file_path` 或命令中的绝对路径：全部在工作区内 → **推翻误判放行**。含外发特征（curl/ssh/scp…）或破坏特征（`rm -rf`…）的命令不享受复核。

### 失败语义

| 情况 | 结果 |
|---|---|
| 模型拿不准 / 输出异常 | 保守 deny + 理由 |
| API 超时（10s）重试（1 次）仍失败 | 保守 deny + "审批服务暂时不可用，稍后重试" |
| 审批服务未配置（缺 key） | **唯一会弹窗的场景**（让配置问题可见） |

## 测试

```bash
node test/test-offline.mjs    # 43 项离线测试（mock fetch，不联网，秒级）
node test/test-live.mjs       # 9 个真实场景（需 key；可传 provider id 做对比）
node tools/probe-api.mjs      # 端点连通性/key 有效性探测（排障用）
```

## 排障

- **判定留痕**：hook 每次被调用都会写本地日志（脚本同目录 `approval-log.txt`，已 gitignore）——时间、工具、原始输入（含 cwd 与工作区变量）、判定结果、耗时、依据。排查"为什么被拦/被放"以它为准。
- ZCode 自己的日志（`~/.zcode/cli/log/`）**不一定记录成功的 hook 执行**，不要用它否定 hook 是否在跑。
- 手动模拟一次调用：
  ```bash
  printf '%s' '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"git status"},"cwd":"/your/project","permission_mode":"default"}' | node hook/approval-hook.mjs
  ```
  无 key 时应无输出、退出码 0（回落人工）。
- hook 不生效：检查 `config.json` 的 `hooks` 块是否还在（ZCode 在 UI 改插件启停时可能重写该文件）。
- 想临时停用：把 `approval-config.json` 的 `active` 改成不存在的值（所有请求 passthrough 转人工）；或切 Full access 模式（不再发起审批请求）。
- **脚本改坏的自救**：hook 脚本一旦崩溃，所有需要审批的操作都会回落人工（体验为"全都卡住"）。此时切 Full access 让 AI 修复脚本，修好再切回；或人工点一次"允许"放行修复操作。**改 hook 脚本后务必先 `node --check` + 手动模拟调用验证再交付**。

## 故障案例与设计教训

以下是本项目开发/使用过程中真实踩过的坑，供同类实现参考：

1. **弹窗闪现**：ZCode 的审批弹窗与 hook 判定是并发的——弹窗先渲染，结果到达后自动关闭，判定耗时即弹窗停留时间。把高频操作（工作区内编辑）放本地快路径后基本消失。
2. **cwd 漂移导致大面积误判**（最严重的一次）：某长会话中 shell 的 `cd` 把 cwd 漂到子目录，快路径不命中、给模型的"工作区根"也失真，模型把项目内路径持续判成"工作区外"，呈"正常窗口↔恶化窗口"交替。修复：向上锚定项目根 + 机械复核。教训：**hook 协议里没有稳定的"会话工作区根"，cwd 是动态值，边界判断必须基于可机械验证的文件系统事实**。
3. **"转人工"等于"卡住"**：早期设计里模型拿不准会转人工弹窗——用户不点就永远挂着，感知就是"卡死"。改为二分类 + 保守拒绝后，所有判定路径都立即返回。
4. **模型会被内容干扰**：编辑内容里出现敏感路径字样时，模型可能把工作区内文件误判成越界写入。快路径（本地比对）天然免疫；Bash 里的绝对路径靠机械复核兜底。
5. **hook 会保护审批配置自身**：对 hooks 配置文件的写入会被自动拒绝（agent 无法关闭审批）。要改钩子配置请人工编辑。

## 已知限制

- 每次非快路径审批消耗一次模型调用（flash 档成本可忽略，但会累积）
- 审批模型的误放行是主要风险面；调整判定规则时宁可保守（prompt 措辞见 `lib.mjs`）
- ZCode 版本升级若改动 hook 协议或内部配置结构，需要回归 `test-offline.mjs` 与真实验收
- hooks 注册是绝对路径耦合：项目/脚本目录改名或移动后必须同步更新 `~/.zcode/cli/config.json`
- 本项目读写的日志文件（`approval-log.txt`）含工具调用参数快照，注意不要把它提交到公开仓库或分享出去

## 项目结构

```
zcode-approval-hook/
├── hook/
│   ├── approval-hook.mjs          # hook 主入口（ZCode 调用）
│   ├── lib.mjs                    # 核心逻辑（快路径/判定/复核/key 解析）
│   ├── approval-config.example.json
│   └── keys.local.example.json
├── test/
│   ├── test-offline.mjs           # 43 项离线测试
│   └── test-live.mjs              # 真实 API 场景测试
├── tools/
│   └── probe-api.mjs              # 端点/key 探测
└── docs/
    ├── permission-request-hook-protocol.md   # ZCode hook 协议笔记
    └── troubleshooting-lessons.md            # 故障案例完整记录
```

## License

MIT
