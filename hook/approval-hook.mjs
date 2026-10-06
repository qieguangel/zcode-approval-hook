// ZCode PermissionRequest 审批 hook（主入口）。
// 输出 allow/deny JSON 自动代批；任何失败/ESCALATE 情况一律无输出退出 0，回落人工弹窗。
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runApproval, resolveKey, loadZcodeProviders } from "./lib.mjs";

const here = (p) => new URL(p, import.meta.url);
const hookLogFile = fileURLToPath(new URL("./approval-log.txt", import.meta.url));

// 判定记录同时写 stderr（进 ZCode 日志）和本地文件（approval-log.txt，排障用）
const log = (...a) => {
  const line = a.join(" ");
  console.error("[approval-hook]", line);
  try { appendFileSync(hookLogFile, `${new Date().toISOString()} ${line}\n`); } catch { /* 记录失败不影响判定 */ }
};

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}
function readJson(url) {
  try { return JSON.parse(readFileSync(url, "utf8")); } catch { return null; }
}

const input = readStdin();
log(`invoked env[ZCODE_PROJECT_DIR=${process.env.ZCODE_PROJECT_DIR || "-"}] raw=` + JSON.stringify(input ?? null).slice(0, 300)); // 被调用的最早证据 + 原始输入 + 工作区变量（诊断用）
if (!input) { log("no/invalid stdin json -> passthrough"); process.exit(0); }

const config = readJson(here("./approval-config.json"));
if (!config?.active || !config?.providers) { log("config missing/invalid -> passthrough"); process.exit(0); }

const providerId = config.active;
const provider = config.providers[providerId];
if (!provider) { log(`active provider '${providerId}' not found -> passthrough`); process.exit(0); }

// key 三级解析：环境变量 > keys.local.json > ZCode 自身 provider 配置（自动指向，无需手填）
const zcodeConfigPath = process.env.ZCODE_PROVIDER_CONFIG
  || join(homedir(), ".zcode", "v2", "config.json");
const zcodeProviders = loadZcodeProviders(zcodeConfigPath);
const keys = readJson(here("./keys.local.json")) || {};
const key = resolveKey(provider, keys, providerId, zcodeProviders);
if (!key) {
  log(`no api key for '${providerId}' (env ${provider.apiKeyEnv || "-"} / keys.local.json / ${zcodeConfigPath}) -> passthrough`);
  process.exit(0);
}

const started = Date.now();
const result = await runApproval(input, { provider, policy: config.policy || {}, key, zcodeProviders });
log(`${input.tool_name} -> ${result.action} (via ${result.via}, ${Date.now() - started}ms${result.detail ? `, ${result.detail}` : ""})`);

if (result.action === "allow") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  }));
} else if (result.action === "deny") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: result.message || "审批模型拒绝该操作" },
    },
  }));
}
// passthrough：不输出 -> ZCode 照常弹人工审批窗
