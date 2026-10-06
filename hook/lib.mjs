// 审批 hook 纯函数库：可离线单测（fetch 可注入 mock）。
// 语义约定：passthrough = 无输出回落人工弹窗（fail-to-human），绝不因故障放行或拒绝。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return ""; }
}

// 从 ZCode 自身的 provider 配置提取凭据，实现"无需手填 key 自动指向"。
// 返回 { [host]: { apiKey, models, kind, baseURL } }。
export function loadZcodeProviders(configPath) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const byHost = {};
    for (const p of Object.values(cfg.provider || {})) {
      const baseURL = p?.options?.baseURL;
      if (!baseURL) continue;
      const host = hostOf(baseURL);
      if (!host) continue;
      const apiKey = p?.options?.apiKey;
      const prev = byHost[host];
      const models = Object.keys(p.models || {});
      byHost[host] = {
        apiKey: (typeof apiKey === "string" && apiKey) || prev?.apiKey || "",
        models: models.length ? models : prev?.models || [],
        kind: p.kind ?? prev?.kind,
        baseURL,
      };
    }
    return byHost;
  } catch { return {}; }
}

const isPlaceholder = (v) =>
  typeof v !== "string" || !v.trim() || /^在这里填|^\.\.\.$|^sk-\.\.\.$/.test(v.trim());

export function resolveKey(provider, keysLocal = {}, providerId = "", zcodeProviders = {}) {
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return process.env[provider.apiKeyEnv];
  const local = keysLocal?.[providerId] ?? keysLocal?.apiKey;
  if (!isPlaceholder(local)) return local.trim();
  if (provider.keySource !== "manual") {
    const fromZcode = zcodeProviders[hostOf(provider.baseURL)]?.apiKey;
    if (!isPlaceholder(fromZcode)) return fromZcode;
  }
  return null;
}

// model 写 "auto" 时，从 ZCode 该 host 的模型列表里挑 flash 档。
export function pickModel(provider, zcodeEntry) {
  if (provider.model && provider.model !== "auto") return provider.model;
  const models = zcodeEntry?.models || [];
  return models.find((m) => /flash/i.test(m)) || models[0] || "deepseek-v4-flash";
}

export function buildUserPrompt(req, policy = {}, roots = workspaceRoots(req)) {
  const maxChars = policy.maxInputChars ?? 2000;
  let toolInput;
  try { toolInput = JSON.stringify(req.tool_input ?? {}); } catch { toolInput = String(req.tool_input); }
  const truncated = toolInput.length > maxChars;
  if (truncated) toolInput = toolInput.slice(0, maxChars) + `…(截断，原始 ${toolInput.length} 字符)`;
  const wsLine = roots.length
    ? `工作区根目录: ${roots.join(" ; ")}（根目录下的所有子目录都属于工作区内；判断是否"工作区外"必须以这个根目录为准，不要以命令的当前目录或其他字段为准）`
    : `工作区根目录: ${req.cwd ?? "-"}`;
  return [
    "你是编码代理的权限审批器。对下面这次工具调用做安全判定：第一行只输出 ALLOW 或 DENY 之一（不要输出任何其他词），第二行必须用一句中文说明判定理由（不超过 50 字）。拿不准时一律判 DENY（保守拒绝）。",
    "",
    "输出格式示例（务必两行齐全）：",
    "ALLOW",
    "工作区内的常规文件编辑，无外部影响。",
    "",
    "DENY",
    "递归删除用户配置目录，属破坏性操作。",
    "",
    "判定规则（信任工作区内的开发操作，严格管控工作区外、凭据与外发）：",
    "1. ALLOW：工作区内的文件读写/编辑/删除；在工作区内运行的构建、测试、脚本、git 操作（含管道、重定向、复杂参数）；只读查看任意位置的日志、配置、文本文件（不修改、不外发）；常规查询命令（ls/find/grep/ps 等）。",
    "2. DENY：写入/删除工作区外路径（如 C:\\Users、系统目录）；删除系统文件；安装/升级依赖（npm install -g、apt、choco 等）；修改系统配置/环境变量/注册表；git push --force、reset --hard、clean 等破坏性操作；把本地代码、密钥或数据发送到外部地址；读取 .ssh/.aws/.gnupg 等凭据私钥。",
    "",
    wsLine,
    `权限模式: ${req.permission_mode ?? req.mode ?? "-"}`,
    `工具名: ${req.tool_name ?? "-"}`,
    `工具参数(JSON): ${toolInput}`,
  ].join("\n");
}

export function parseVerdict(text) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/[*_`#>]/g, "").trim());
  const firstLine = lines.find(Boolean) || "";
  const up = firstLine.toUpperCase();
  const reason = lines.slice(lines.indexOf(firstLine) + 1).filter(Boolean).join(" ").slice(0, 200);
  if (up.startsWith("ALLOW")) return { verdict: "ALLOW", reason };
  if (up.startsWith("DENY")) return { verdict: "DENY", reason };
  return { verdict: "ESCALATE", reason: (firstLine + " " + reason).trim().slice(0, 200) };
}

// 白名单只对"无链式/分段/替换符"的单一命令生效，防 `ls; rm -rf`、`$(...)`、`>` 重定向绕过。
export function bashWhitelisted(cmd, whitelist = []) {
  if (!whitelist.length) return false;
  const s = String(cmd ?? "").trim();
  if (!s) return false;
  if (/[;&|`$()\n<>]/.test(s)) return false;
  const lower = s.toLowerCase();
  return whitelist.some((w) => {
    const wl = String(w).toLowerCase().trim();
    return lower === wl || lower.startsWith(wl + " ");
  });
}

const normPath = (s) => String(s).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// 从起点向上找项目根：最近的、含 .git 或 AGENTS.md 的祖先目录。
// 背景（2026-10-05 故障）：ZCode 只给动态 cwd（会漂移到 tmp\extract 之类子目录），
// 且 ZCODE_PROJECT_DIR 实测同样随 cwd 变化——没有"会话工作区根"字段可用。
// 向上搜项目标记目录是可靠替代：子目录里的 cwd 也能锚定回真正的项目根。
export function findProjectRoot(start) {
  try {
    let cur = String(start || "");
    if (!cur) return null;
    for (let i = 0; i < 16; i++) {
      if (existsSync(join(cur, ".git")) || existsSync(join(cur, "AGENTS.md"))) return normPath(cur);
      const parent = dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
  } catch { /* 探测失败则忽略 */ }
  return null;
}

// 工作区根解析：ZCODE_PROJECT_DIR / cwd 各自向上找项目根，加上自身，构成候选根集合。
export function workspaceRoots(input) {
  const raw = [process.env.ZCODE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, input?.cwd];
  const roots = [];
  for (const r of raw) {
    if (!r) continue;
    const n = normPath(r);
    if (n && !roots.includes(n)) roots.push(n);
    const proj = findProjectRoot(r);
    if (proj && !roots.includes(proj)) roots.push(proj);
  }
  return roots;
}

export function inWorkspace(p, roots) {
  if (!p || !roots?.length) return false;
  const n = normPath(p);
  return roots.some((r) => n === r || n.startsWith(r + "/"));
}

// 工作区内文件写入快速放行：本地判断 file_path 是否落在任一工作区根内，0ms，不调模型。
export function workspaceWriteAllowed(input, roots = workspaceRoots(input)) {
  return inWorkspace(input?.tool_input?.file_path, roots);
}

// 机械复核：模型以"路径越界"为由拒绝时，用本地事实证伪该断言。
// 工作区边界是可机械验证的事实，不应该交给模型"回忆"；证伪成功则推翻误判。
const BOUNDARY_CLAIM = /工作区外|越界|超出.{0,8}范围|工作区边界|上级仓库|非当前工作区/;

export function workspaceOverride(input, roots) {
  if (!roots?.length) return null;
  const ti = input?.tool_input || {};
  // 文件类工具：直接比对 file_path
  if (ti.file_path && inWorkspace(ti.file_path, roots)) {
    return `file_path 经本地比对确认在工作区内（${ti.file_path}）`;
  }
  // Bash：仅当命令中提取到的绝对路径全部在工作区内，且无外发/破坏特征时才推翻
  if (input?.tool_name === "Bash" && typeof ti.command === "string") {
    const cmd = ti.command;
    if (/\b(curl|wget|ssh|scp|sftp|Invoke-WebRequest|nc|telnet)\b/i.test(cmd)) return null;
    if (/(^|\s)rm\s+-[a-z]*[rf]|del\s+\/[sq]|format\s+[a-z]:|rd\s+\/s/i.test(cmd)) return null;
    const winPaths = cmd.match(/[A-Za-z]:[\\/][^\s"'|;&<>()]*/g) || [];
    const unixPaths = (cmd.match(/(?:^|\s)(\/[a-z]\/[^\s"'|;&<>()]*)/gi) || []).map((s) => s.trim());
    const all = [...winPaths, ...unixPaths];
    if (all.length && all.every((p) => inWorkspace(p, roots))) {
      return `命令中 ${all.length} 个绝对路径经本地比对全部在工作区内`;
    }
  }
  return null;
}

export { BOUNDARY_CLAIM };

export async function runApproval(input, { provider, policy = {}, key, fetchImpl = fetch, zcodeProviders = {} }) {
  const roots = workspaceRoots(input);
  if (input.tool_name === "Bash" && bashWhitelisted(input.tool_input?.command, policy.bashWhitelist)) {
    return { action: "allow", via: "whitelist" };
  }
  if ((input.tool_name === "Write" || input.tool_name === "Edit") && workspaceWriteAllowed(input, roots)) {
    return { action: "allow", via: "workspace-write" };
  }
  // 工作区内的常规 git 备份操作直接放行（守则将 git 备份列为最高优先级，不应被审批误伤）
  if (input?.tool_name === "Bash" && typeof input.tool_input?.command === "string") {
    const gc = input.tool_input.command.trim();
    if (!/[;&|`$\n]/.test(gc) && /^git\s+(add|commit|status|log|diff|show|branch|tag)\b/i.test(gc) && !/--force|--hard/.test(gc)) {
      return { action: "allow", via: "git-local" };
    }
  }
  const body = {
    model: pickModel(provider, zcodeProviders[hostOf(provider.baseURL)]),
    messages: [{ role: "user", content: buildUserPrompt(input, policy, roots) }],
    max_tokens: policy.maxTokens ?? 8192,
    temperature: 0,
    ...(provider.extraBody || {}),
  };
  const url = String(provider.baseURL).replace(/\/+$/, "") + "/chat/completions";
  const timeoutMs = policy.apiTimeoutMs ?? 45000;
  const retries = policy.maxRetries ?? 1;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(provider.extraHeaders || {}),
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("empty content (reasoning 可能吃满 max_tokens)");
      const { verdict, reason } = parseVerdict(content);
      if (verdict === "ALLOW") return { action: "allow", via: "model" };
      if (verdict === "DENY") {
        // 机械复核：模型以"路径越界"为由拒绝时，用本地事实证伪该断言再定夺。
        // 工作区边界是可机械验证的事实，不应交给模型"回忆"（2026-10-05 故障的核心教训）。
        if (BOUNDARY_CLAIM.test(reason)) {
          const proof = workspaceOverride(input, roots);
          if (proof) return { action: "allow", via: "boundary-override", detail: proof };
        }
        return { action: "deny", via: "model", message: `审批模型判定为高风险并拒绝：${reason || "模型未给出详细理由，如需强制执行请切到 Full access 模式"}` };
      }
      // 模型未能明确判定（含输出异常）：保守拒绝，不转人工弹窗（弹窗会挂起等待）
      return { action: "deny", via: "model-unclear", message: `审批模型无法确定安全性，已保守拒绝：${reason || "无理由"}；如需强制执行请切到 Full access 模式。` };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  // 运行时故障（超时/网络/HTTP 错误/模型输出异常）：保守拒绝并说明理由。
  // 不转人工弹窗——弹窗会无限期挂起等待，用户明确反馈"卡住"体验差；拒绝会立即返回，可重试。
  const brief = String(lastErr?.message || lastErr).slice(0, 120);
  return {
    action: "deny",
    via: "error",
    message: `审批服务暂时不可用（${brief}），已按保守策略拒绝本次操作；稍后重试即可，如需强制执行可切换 Full access 模式。`,
  };
}
