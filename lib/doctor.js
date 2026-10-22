import path from "node:path";
import fs from "node:fs";

import * as core from "./core.js";

/**
 * 体检：回答"现在这套东西到底还成不成立"。
 * 只做只读判断，不修复；修复交给 --apply。
 */

function lstatSafe(fp) {
  try { return fs.lstatSync(fp); } catch { return null; }
}

function realOrSelf(fp) {
  try { return fs.realpathSync.native(fp); } catch { return path.normalize(fp); }
}

/** junction / symlink 的目标；普通目录返回 null。 */
export function linkTarget(fp) {
  const st = lstatSafe(fp);
  if (!st || !st.isSymbolicLink()) return null;
  try { return realOrSelf(fs.readlinkSync(fp)); } catch { return "?"; }
}

export function baselinePath(dshHome) {
  return path.join(dshHome, "dsh-purge", "baseline.json");
}

export function readBaseline(dshHome) {
  try {
    return JSON.parse(fs.readFileSync(baselinePath(dshHome), "utf8"));
  } catch {
    return null;
  }
}

export function writeBaseline(dshHome, data) {
  const fp = baselinePath(dshHome);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2) + "\n", "utf8");
  return fp;
}

/**
 * @param {{state:object, repo?:string, linkPaths?:string[]}} input
 * @returns {{ok:boolean, rows:Array<{id:string,ok:boolean,detail:string}>}}
 */
export function runChecks(input = {}) {
  const state = input.state || {};
  const rows = [];
  const add = (id, ok, detail) => rows.push({ id, ok, detail });

  const base = state.ai_base;
  add("host", Boolean(base), base ? `主宿主 ${base}` : "没定位到宿主 @deepseek-ai（先 --apply 或给 --base）");

  const applicable = Math.max(0, (state.patches_total || 0));
  const applied = state.patches_applied || 0;
  const pending = state.patches_pending || 0;
  const baseline = input.baseline || null;
  if (baseline && typeof baseline.applied === "number") {
    add(
      "patches",
      applied >= baseline.applied && pending === 0,
      `已清洗 ${applied}（基线 ${baseline.applied}，${baseline.at || "?"}）, 待清洗 ${pending}`,
    );
  } else {
    add("patches", Boolean(base) && pending === 0 && applied > 0, `已清洗 ${applied}/${applicable}, 待清洗 ${pending}（无基线）`);
  }

  add("backup", state.has_backup === true, state.has_backup ? "补丁备份在位（可 --revert）" : "没有补丁备份，回滚会失败");

  const shimOk = state.shim_cmd === "patched" || state.shim_cmd === "original" || state.shim_cmd === "injected";
  add("shim", shimOk, `dsh.cmd=${state.shim_cmd || "missing"}`);

  add("asar", state.asar_still_sealed !== true, state.asar_still_sealed ? "桌面 app.asar 仍封包：补丁会被官方更新覆盖" : "bundle 已解包（补丁可落盘）");
  add("hooks", true, `hooksDenyBypass=${state.hooks_deny_bypass === false ? "off" : "on"}`);

  const links = input.linkPaths || [];
  if (links.length) {
    for (const lp of links) {
      const target = linkTarget(lp);
      const show = target ? `→ ${target}` : "是实体目录（不是链接）";
      const parts = path.normalize(lp).split(path.sep).filter(Boolean);
      const id = `link:${parts.slice(-2).join("/")}`;
      if (!target) {
        add(id, true, `${lp} ${show}`);
        continue;
      }
      const ok = input.repo ? path.normalize(target).toLowerCase() === path.normalize(realOrSelf(input.repo)).toLowerCase() : true;
      add(id, ok, `${lp} ${show}${ok ? "" : `（期望 ${realOrSelf(input.repo)}）`}`);
    }
  }

  return { ok: rows.every((r) => r.ok), rows };
}

export default function doctorModule() {
  return { runChecks, linkTarget, readBaseline, writeBaseline, baselinePath };
}
