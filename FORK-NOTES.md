# FORK NOTES — 跑在 DSH 0.2.0-rc.2 上的可用副本

上游：<https://github.com/YuJunZhiXue/dsh-purge>（MIT，见 `LICENSE`）
本仓库版本：`dsh-purge 1.1.71`，针对 **DSH 0.2.0-rc.2（desktop / `resources/app`）** 打了三处修复。
不是上游的发布分支，也不带任何本机数据（`$DSH_HOME/redteam/config.json`、密钥、engagement 记录都不在仓库里）。

## 修复 1 — `#40 COMPLETE_PROMPT_KEEP_INJECT` 命中不到 rc.2 的 complete 收尾块

rc.2 的 `SystemPrompt.assemble()` 在收尾块前多插了一行 `const requiredContexts = new Set(...)`，
`contexts` 分支也从 `[]` 变成 `filter(required)`。原来 7 个 pattern 全部 `matchesPattern=false`
→ `patchStatus` 返回 **`skipped`（不是 `pending`）** → `ensureHostClean()` 的 `needsApply` 直接跳过 apply
→ 标记 `[dsh-purge] complete prompt keeps waterfall inject` 永远写不上
→ `hostPromptKeepsInject()` 恒 false → `allPatchHostsWritten()` 恒 false
→ 重启门禁永久输出「清洗没有写进全部宿主，已取消重启」。

修法（`lib/core.js`）：

- 新增 `COMPLETE_PROMPT_WATERFALL_INJECT_02`，精确匹配 rc.2 的 `requiredContexts` 形状，保留原语义
  （`purge 段 + rest 尾 + complete 收尾`，`requiredContexts` 过滤逻辑原样保留）；
- 末尾追加**兜底 pattern**：任何未来形状只要还留着
  `sections: completeSection === void 0 ? transformed.sections : [completeSection],`
  就就地改成保留 dsh-purge inject 段 —— 这类「官方改形 → skipped → 永久取消重启」不会再复现；
- 两条都幂等（已 apply 的文件再跑 `applyReplacementsToText` 不再变化）。

## 修复 2 — `hostFs` 缺 `closeSync` / `readSync`（静默失效，不抛错）

`core.js` 里 `const fs = hostFs`，而 `lib/extract-asar.js` 的 `HOST_SYNC` 只有 `openSync`：

- `backupAll()` 的 `fs.closeSync(placeholderFd)` 抛 `TypeError`（被 `try/catch` 吞）→ 占位 fd 泄漏
  → 目标文件一直被本进程占着 → `rename(tmp, *.dshpurge.bak)` 每个文件 `EPERM`
  → 全量备份 **0 条**、`hasBackup()` 恒 false、`revert` 没有原件可回；
- `isTextShim()` 的 `fs.readSync` 每次抛错 → 一律判「非文本 shim」→ `dsh.ps1` / `dsh` 永不注入。

修法：`HOST_SYNC` 补 `closeSync / readSync / writeSync / fsyncSync / fstatSync / accessSync`。

## 修复 3 — 红队 preset 在 rc.2 注册即 broken（模式"消失"）

rc.2 的 `dsh-tool-subagent` 在 `apply()` 里硬弃用两个 config 键：

```js
for (const field of ["persona", "toolFilter"]) if (Object.hasOwn(config, field))
  throw new Error(`tool-subagent: ${field} is no longer supported; configure persona and tool plugins
  in an Agent Preset and select it with agentPreset (spawn only)`);
```

`presets/redteam/agent.cordis.yml` 的 `tool-subagent` 行还带着 `toolFilter.deny: [subagent_fork, workflow, ralph]`
→ `ctx.agentPresets.register()` 后 `phase: registered-broken`
→ 模式下拉过滤掉 broken preset → registry 回落 `standard` → `isRedteamSession()` false
→ 红队人格 / 角色段 / skills 全不挂（日志 `redteam=false`）。

修法：删掉 `toolFilter` 块，保留 `maxDepth: 1`（把递归预算收死）。
要把子会话的工具目录也收紧，0.2 的正解是另建一个不含 delegation 组的 leaf preset，
在该行写 `agentPreset: <leaf>`（只有 spawn provider 支持独立选 preset）。

## 回归测试

```bash
node scripts/check-40-and-hostfs.mjs
```

覆盖：`#40` rc.2 形状命中、标记写入、`requiredContexts` 语义保留、幂等、未知新形状走兜底、
`hostFs` 同步方法完整性、备份 `rename` 不再 `EPERM`。当前 18 项全 PASS。

## 与上游的差异面

```
lib/core.js                                            # 修复 1 + 诊断增强（promptDropReport / hostsUnwritten）
lib/extract-asar.js                                    # 修复 2
presets/redteam/agent.cordis.yml                        # 修复 3
scripts/check-40-and-hostfs.mjs                        # 新增回归测试
```

`promptDropReport(aiBase)` 是新增的诊断导出：逐项返回 `identityMarked / injectMarked / identityLeft /
dropsInject / isPromptModule` 和 `reason`，门禁失败时会连宿主路径、`#40` 状态一起返回，
不再只丢一句「没写进全部宿主」。
