import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-activation-"));
const install = path.join(temp, "DeepSeek Harness");
const aiBase = path.join(install, "resources/app/dsh/node_modules/@deepseek-ai");
const keys = ["DSH_SURFACE", "DSH_DESKTOP_INSTALL", "DSH_HOME", "DSH_BASE"];
const oldEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  fs.mkdirSync(path.join(aiBase, "dsh-agent-instructions/lib"), { recursive: true });
  fs.mkdirSync(path.join(aiBase, "dsh-system-prompt/lib"), { recursive: true });
  fs.mkdirSync(path.join(install, ".dsh"));
  fs.writeFileSync(path.join(install, "DeepSeek Harness.exe"), "fixture");
  fs.writeFileSync(path.join(install, "resources/app.asar"), "sealed fixture");
  fs.writeFileSync(path.join(aiBase, "dsh-system-prompt/lib/index.js"),
    '// system-prompt/assemble\n// [dsh-purge] identity stripped\n// [dsh-purge] complete prompt keeps waterfall inject\n');
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_DESKTOP_INSTALL = install;
  process.env.DSH_HOME = path.join(install, ".dsh");
  process.env.DSH_BASE = aiBase;
  const core = await import("../lib/core.js");
  const reapply = await import("../lib/reapply.js");
  assert.equal(core.desktopAsarStillSealed(), true);
  assert.equal(core.hostCleanMarkersPresent(aiBase), true);
  assert.equal(await reapply.hostCleanEnoughToKeep(), false,
    "An already patched extraction cannot certify the sealed running host");
  console.log("PASS a sealed host cannot receive a false kept-patches success");

  const written = { ai_base: aiBase, host_written: true, asar_still_sealed: false, patches_total: 4, patches_ready: 4, patches_pending: 0 };
  assert.deepEqual(core.patchActivationStatus({ ...written, asar_still_sealed: true }), { patches_active: false, activation_pending: true });
  assert.deepEqual(core.patchActivationStatus(written), { patches_active: true, activation_pending: false });
  assert.equal(core.patchActivationStatus({ ...written, patches_pending: 1 }).patches_active, false);
  assert.equal(core.patchActivationStatus({ ...written, patches_ready: 3 }).patches_active, false);
  assert.equal(core.patchActivationStatus({ ...written, host_written: false }).patches_active, false);
  assert.equal(core.patchActivationStatus({ ...written, ai_base: null }).patches_active, false);
  assert.equal(core.patchActivationStatus({ ...written, patches_total: 0, patches_ready: 0 }).patches_active, false);
  console.log("PASS activation requires an unsealed, located, written, fully ready host");

  const state = await core.gatherState();
  assert.equal(state.asar_still_sealed, true);
  assert.equal(state.patches_active, false);
  assert.equal(state.activation_pending, true);
  console.log("PASS real status collection exposes the pending activation");
  console.log("ALL PASS");
} finally {
  for (const key of keys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
}
