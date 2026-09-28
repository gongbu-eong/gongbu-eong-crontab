import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const model of ["configured-test-model", ""]) {
  test(`community AI reads GPT_API_KEY and ${model ? "OPENAI_MODEL" : "the default model"}`, () => {
    // Import from an empty working directory so tests never load a real .env.
    const directory = mkdtempSync(join(tmpdir(), "community-config-test-"));
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        process.chdir(process.env.CONFIG_TEST_DIRECTORY);
        const config = await import(process.env.CONFIG_TEST_MODULE);
        const { env } = config.default ?? config;
        assert.equal(env.communitySeedApiKey, "test-only-key");
        assert.equal(env.communitySeedModel, ${JSON.stringify(model || "gpt-5.1")});
        assert.equal(env.communitySeedEnabled, false);
      `], {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DATABASE_URL: "postgresql://test:test@localhost/test",
          GPT_API_KEY: " test-only-key ",
          OPENAI_MODEL: model,
          CONFIG_TEST_DIRECTORY: directory,
          CONFIG_TEST_MODULE: new URL("./config.ts", import.meta.url).href,
        },
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    } finally {
      rmdirSync(directory);
    }
  });
}
