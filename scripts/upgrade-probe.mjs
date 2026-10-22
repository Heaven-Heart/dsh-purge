#!/usr/bin/env node
// 升级/重装后探针：体检一次，掉档就推飞书。
// 用法:
//   node scripts/upgrade-probe.mjs              # 只体检，失败 exit 1
//   node scripts/upgrade-probe.mjs --notify     # 失败时推一条（同因不重复推）
//   node scripts/upgrade-probe.mjs --notify --force   # 强制推（自测用）
//   node scripts/upgrade-probe.mjs --json
// 环境:
//   DSH_PURGE_NOTIFY_SSH   默认 ubuntu（ssh config 里的 .75）；置空则只落日志不推
//   HERMES_TARGET          默认 feishu:oc_db24314af23d2274e36bc3c30cb1aaab
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import * as core from "../lib/core.js";
import * as doctor from "../lib/doctor.js";

const args = process.argv.slice(2);
const wantNotify = args.includes("--notify");
const force = args.includes("--force");
const wantJson = args.includes("--json");

const sshHost = process.env.DSH_PURGE_NOTIFY_SSH ?? "ubuntu";
const hermesBin = process.env.HERMES_BIN || "/home/ubuntu/biz/hermes-agent/.venv/bin/hermes";
const target = process.env.HERMES_TARGET || "feishu:oc_db24314af23d2274e36bc3c30cb1aaab";

const state = await core.gatherState({ hosts: true, discover: true });
const dshHome = state.dsh_home;
const baseline = doctor.readBaseline(dshHome);

const statePath = path.join(dshHome, "dsh-purge", "probe-state.json");
const readStateFile = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; }
};
const writeStateFile = (obj) => {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
  } catch {}
};

// 看门狗每轮调用时不必重扫（体检一次约 3s）：默认 30 分钟内不重复检查。
const minInterval = Number(process.env.DSH_PURGE_PROBE_MIN_INTERVAL || (wantNotify ? 1800 : 0)) * 1000;
const prev = readStateFile();
const lastCheck = prev.last_check_at ? Date.parse(prev.last_check_at) : 0;
if (minInterval > 0 && !force && Date.now() - lastCheck < minInterval) {
  process.exit(0);
}

const result = doctor.runChecks({ state, repo: process.env.DSH_PURGE_REPO || "", baseline });

const failed = result.rows.filter((r) => !r.ok);
const signature = failed.map((r) => r.id).sort().join(",");

if (wantJson) {
  console.log(JSON.stringify({ ok: result.ok, rows: result.rows, signature }, null, 2));
} else if (result.ok) {
  console.log(`[probe] ok  ${state.surface}  ${state.patches_applied}/${state.patches_total}  applied`);
} else {
  console.log(`[probe] FAIL  ${failed.length} 项未通过：`);
  for (const r of failed) console.log(`  ✗ ${r.id} ${r.detail}`);
}

if (!result.ok) process.exitCode = 1;

if (!wantNotify) process.exit(process.exitCode || 0);
if (result.ok && !force) {
  writeStateFile({ ok: true, at: new Date().toISOString(), last_check_at: new Date().toISOString(), signature: "" });
  process.exit(0);
}

// 同因不重复推：签名没变且 12 小时内推过就静默。
const lastAt = prev.last_notify_at ? Date.parse(prev.last_notify_at) : 0;
const sameReason = prev.last_signature === signature;
const fresh = Date.now() - lastAt < 12 * 3600 * 1000;
if (!force && sameReason && fresh) {
  console.log("[probe] 同一原因 12 小时内已推过，跳过");
  process.exit(process.exitCode || 0);
}

const subject = force
  ? "【测试】dsh-purge 探针通知链路"
  : `dsh-purge 掉档：${failed.length} 项体检未通过`;
const lines = [
  `宿主 surface：${state.surface}`,
  `插件根：${state.ai_base || "(未定位)"}`,
  `补丁：${state.patches_applied}/${state.patches_total} 已清洗，待清洗 ${state.patches_pending}`,
  baseline ? `基线：${baseline.applied}（${baseline.at}）` : "基线：无（跑 --doctor --save-baseline 建一条）",
  "",
  ...(failed.length ? failed.map((r) => `✗ ${r.id}: ${r.detail}`) : ["（--force 自测，体检实际通过）"]),
  "",
  "处置：dsh-purge --doctor 看详情；多数情况重跑 dsh-purge --apply 再重启 DSH 即可。",
];
const body = lines.join("\n");

if (!sshHost) {
  console.log("[probe] DSH_PURGE_NOTIFY_SSH 为空，只落本地状态不推送");
  writeStateFile({ ok: result.ok, at: new Date().toISOString(), signature, last_check_at: new Date().toISOString(), last_notify_at: prev.last_notify_at || "" });
  process.exit(process.exitCode || 0);
}

try {
  execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshHost,
    `${hermesBin} send --to ${target} --subject ${JSON.stringify(subject)} -q`], {
    input: body,
    encoding: "utf8",
    timeout: 120000,
  });
  console.log(`[probe] 已推送 → ${target}`);
  writeStateFile({ ok: result.ok, at: new Date().toISOString(), signature, last_check_at: new Date().toISOString(), last_notify_at: new Date().toISOString() });
} catch (e) {
  console.log(`[probe] 推送失败：${e.message.split("\n")[0]}`);
  writeStateFile({ ok: result.ok, at: new Date().toISOString(), signature, last_check_at: new Date().toISOString(), last_notify_at: prev.last_notify_at || "" });
  process.exitCode = 2;
}
