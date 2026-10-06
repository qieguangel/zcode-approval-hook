// 探测 ZCode 自带 provider 配置里的 key 是否可直接用于审批 API，并找出可用端点。
// 只打印掩码信息，绝不输出明文 key。运行：node probe-api.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ZCODE_CONFIG = join(homedir(), ".zcode", "v2", "config.json");
const cfg = JSON.parse(readFileSync(ZCODE_CONFIG, "utf8"));

const found = [];
for (const [id, p] of Object.entries(cfg.provider || {})) {
  const baseURL = p?.options?.baseURL || "";
  const apiKey = p?.options?.apiKey || "";
  if (baseURL.includes("opencode.ai") && apiKey) {
    found.push({ id, name: p.name, kind: p.kind, baseURL, apiKey, models: Object.keys(p.models || {}) });
  }
}
if (!found.length) { console.log("未在 ZCode 配置中找到 opencode.ai provider"); process.exit(1); }

for (const f of found) {
  console.log(`provider: ${f.name} (${f.id})`);
  console.log(`  baseURL: ${f.baseURL}`);
  console.log(`  kind: ${f.kind}`);
  console.log(`  key: ${f.apiKey.slice(0, 6)}...(len=${f.apiKey.length})`);
  console.log(`  models: ${f.models.join(", ")}`);
}

const target = found[0];
const modelsToTry = [...new Set([...target.models, "deepseek-v4-flash"])];
console.log(`\n候选模型：${modelsToTry.join(", ")}`);
console.log("（补上 x-opencode-session 头，这是 Console Go 网关的强制要求）\n");

const sessionId = "zcode-approval-probe-" + Math.random().toString(36).slice(2, 10);

const endpoints = [
  { name: "OpenAI /chat/completions", url: target.baseURL.replace(/\/+$/, "") + "/chat/completions", style: "openai", auth: "bearer" },
  { name: "Anthropic /messages", url: target.baseURL.replace(/\/+$/, "") + "/messages", style: "anthropic", auth: "xapikey" },
];

const body = (style, model) =>
  style === "openai"
    ? { model, messages: [{ role: "user", content: "只回复一个词：ALLOW" }], max_tokens: 512, temperature: 0 }
    : { model, max_tokens: 512, messages: [{ role: "user", content: "只回复一个词：ALLOW" }] };

for (const ep of endpoints) {
  for (const model of modelsToTry) {
    const started = Date.now();
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-session": sessionId,
          ...(ep.auth === "bearer" ? { authorization: `Bearer ${target.apiKey}` } : { "x-api-key": target.apiKey }),
          ...(ep.style === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
        },
        body: JSON.stringify(body(ep.style, model)),
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      console.log(`  [${res.status}] ${ep.name} / ${model} (${Date.now() - started}ms)`);
      console.log(`        ${text.slice(0, 300).replace(/\s+/g, " ")}`);
    } catch (err) {
      console.log(`  [ERR] ${ep.name} / ${model} (${Date.now() - started}ms): ${err.message}`);
    }
  }
}
