# ZCode PermissionRequest Hook 协议笔记

来源：ZCode 官方 hooks 文档（`https://zcode.z.ai/en/docs/hooks`）抓取 + 本机实测交叉验证。供基于同一扩展点做二次开发时参考。

## 触发时机

**仅当权限决策本来会弹窗问用户时**触发。已被 Always Allow 规则、权限模式（如 Edit automatically 的文件编辑）放行的操作不会走到这个 hook。

实测补充：被 ZCode 内置判定为安全的只读操作（`cat`/`ls`/`grep` 等）既不弹窗也不触发 hook。

## stdin 输入（一行 JSON + 换行）

官方文档描述的通用结构：

```json
{
  "session_id": "session-123",
  "transcript_path": "/tmp/zcode-hook/transcript.jsonl",
  "cwd": "/workspace/demo",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Write",
  "tool_input": { "file_path": "src/index.ts", "content": "..." },
  "tool_use_id": "tool-123"
}
```

### 实测字段（以真实 hook 收到的数据为准）

```json
{
  "cwd": "D:\\path\\to\\project",          // 动态当前目录，会随 shell cd 漂移！
  "hookEventName": "PermissionRequest",    // 驼峰；snake_case 别名同时存在
  "mode": "build",
  "reason": "High risk tools require explicit approval",
  "requestId": "perm_...",
  "riskLevel": "high",                     // ZCode 自带风险分级（medium/high/low）
  "sessionId": "sess_...",
  "sideEffectScope": "system",             // system / workspace
  "toolCallId": "call_...",
  "toolInput": { "command": "..." },       // 与 tool_input 并存
  "timestamp": "..."
}
```

要点：

- 同一输入**同时含驼峰与 snake_case 两套字段**（`toolInput`/`tool_input`、`hookEventName`/`hook_event_name`），读哪套都行
- 实测 Bash 命令一律标 `sideEffectScope: "system"` + `riskLevel: "high"`（即使只是无害查询），文件编辑标 `workspace` + `medium`——分级偏保守，可参考但别依赖
- **`cwd` 是动态值**：实测会随 shell 的 `cd` 漂移到子目录，且 `ZCODE_PROJECT_DIR` 环境变量同样跟随变化。协议里没有稳定的"会话工作区根"。做路径边界判断请向上搜索项目标记目录（`.git`、`AGENTS.md` 等），见 troubleshooting 文档的故障案例 2

## stdout 输出（严格 JSON schema）

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "拒绝理由（展示给用户）"
    }
  }
}
```

- `behavior` 只有 `allow` / `deny`（**没有 ask**；不输出 = 不干预 = 人工弹窗照常）
- deny 时 `message` 会作为拒绝理由展示
- decision 还可带 `updatedInput` / `updatedPermissions`（旧写法 `permissionUpdates` 也接受）
- 退出码：`0` 通过（空 stdout 即不干预）、`2` deny、其他非零 = hook 报错
- stdout 上限 32768 字节（根级 `maxOutputBytes` 可调）；**多余字段会导致整个输出校验失败被丢弃**

## 注册（用户级 `~/.zcode/cli/config.json`）

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 120000,
    "events": {
      "PermissionRequest": [
        {
          "matcher": "Bash|Write|Edit",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["/abs/path/approval-hook.mjs"],
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

- **必须用户级**：工作区级 hooks 会被整体忽略；**必须 `hooks.enabled: true`**（配置文件 hooks 默认关闭；插件贡献 hook 时自动启用）
- `matcher` 是大小写敏感正则（工具名）；省略 = 全部匹配。别名：`Task`↔`Agent`、`ApplyPatch`→`Write`/`Edit`
- `type: "process"`：argv 直调无 shell，跨平台最稳（推荐）。`type: "command"` 走 shell、支持 `async: true`，但 async 是 fire-and-forget，**无法用于阻塞决策**
- 超时：hook 级 `timeoutMs` > 根级默认 60000ms。审批 hook 建议 60~120s
- 执行顺序：user hooks → plugin hooks
- 模板变量：`${ZCODE_PROJECT_DIR}`、`${CLAUDE_SESSION_ID}` 会展开并注入环境变量（插件 hook 另有 `${ZCODE_PLUGIN_ROOT}`）

## 硬性安全限制

> "Explicit deny rules, Plan-mode write bans, and hard tool limits cannot be bypassed by a hook allow."

hook 的 allow 不能越过：显式 deny 规则、Plan 模式写禁令、硬工具限制。

## 诊断

- hook 的 stderr 会进入 ZCode 日志（`~/.zcode/cli/log/`），但**成功的 hook 执行不一定有记录**——可靠的留痕方式是在 hook 脚本内写本地日志文件
- 插件 hooks 可在 Settings → Plugin Management 的插件详情里看 runnable 状态
