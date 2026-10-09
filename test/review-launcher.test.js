import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function fixture(t, exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), "review-launcher-"));
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "tools"));
  await cp(new URL("../bin/review", import.meta.url), join(root, "bin/review"));
  const write = (name, script) => writeFile(join(root, "tools", name), script, { mode: 0o755 });
  await write(
    "node",
    `#!/bin/bash\nif [[ "$1" == *provider-config.js ]]; then echo codex; else exec '${process.execPath}' '${root}/generator.mjs'; fi\n`,
  );
  await writeFile(
    join(root, "generator.mjs"),
    `console.log('Repository research started.'); await new Promise(resolve=>setTimeout(resolve,300)); console.log('Writing walkthrough completed.'); console.log('Slug: owner-repo-42'); process.exit(${exitCode});`,
  );
  await write("lsof", "#!/bin/bash\nexit 0\n");
  await write("open", `#!/bin/bash\nprintf '%s' "$1" > '${root}/opened-url'\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn("bash", [join(root, "bin/review"), "https://github.com/owner/repo/pull/42"], {
    env: { ...process.env, PATH: join(root, "tools") + ":" + process.env.PATH },
    cwd: root,
  });
  let output = "",
    early = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (
      output.includes("Repository research started.") &&
      !output.includes("Writing walkthrough completed.")
    )
      early = true;
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const logs = await readdir(join(root, "logs"));
  return {
    root,
    code,
    output,
    stderr,
    early,
    log: await readFile(join(root, "logs", logs[0]), "utf8"),
  };
}

test("launcher streams progress before completion, logs it once and opens the emitted slug", async (t) => {
  const result = await fixture(t);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.early, true);
  assert.equal(result.output.split("Repository research started.").length, 2);
  assert.match(result.log, /Repository research started/);
  assert.equal(
    await readFile(join(result.root, "opened-url"), "utf8"),
    "http://localhost:5200/?pr=owner-repo-42",
  );
});
test("tee cannot mask a generator failure or open a failed walkthrough", async (t) => {
  const result = await fixture(t, 7);
  assert.equal(result.code, 7);
  assert.equal(result.early, true);
  assert.match(result.log, /Generation failed \(exit code 7\)/);
  await assert.rejects(readFile(join(result.root, "opened-url")), { code: "ENOENT" });
});
