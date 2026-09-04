import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const SCHEMA = `
  create table if not exists projects (
    id text primary key,
    user_id text not null,
    name text not null,
    description text not null default '',
    created_at timestamptz not null default now()
  );
  create index if not exists projects_user_id_idx on projects (user_id);
`;

async function openCluster(dir: string): Promise<PGlite> {
  const pg = new PGlite({ dataDir: dir, relaxedDurability: false });
  await pg.waitReady;
  await pg.exec(SCHEMA);
  return pg;
}

describe("PGLite filesystem persistence", { timeout: 90_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-pglite-persist-"));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps user-scoped projects after close and reopen (execution restart)", async () => {
    const first = await openCluster(dir);
    await first.query(
      "insert into projects (id, user_id, name, description) values ($1, $2, $3, $4)",
      ["proj-keep", "user-sandbox", "Sandbox Keep", "must survive restart"],
    );
    await first.query(
      "insert into projects (id, user_id, name, description) values ($1, $2, $3, $4)",
      ["proj-other", "user-other", "Other Account", "must not leak"],
    );
    await first.close();

    const second = await openCluster(dir);
    const mine = await second.query<{ id: string; name: string }>(
      "select id, name from projects where user_id = $1 order by name",
      ["user-sandbox"],
    );
    const other = await second.query<{ id: string }>(
      "select id from projects where user_id = $1",
      ["user-other"],
    );
    const leaked = await second.query<{ id: string }>(
      "select id from projects where user_id = $1 and id = $2",
      ["user-sandbox", "proj-other"],
    );
    assert.equal(mine.rows.length, 1);
    assert.equal(mine.rows[0]?.id, "proj-keep");
    assert.equal(mine.rows[0]?.name, "Sandbox Keep");
    assert.equal(other.rows.length, 1);
    assert.equal(leaked.rows.length, 0);
    await second.close();
  });

  it("stress: 12 sequential restarts keep the same project row", async () => {
    const id = "proj-stress";
    const seed = await openCluster(dir);
    await seed.query(
      "insert into projects (id, user_id, name, description) values ($1, $2, $3, $4) on conflict (id) do nothing",
      [id, "user-sandbox", "Stress Keep", "n=0"],
    );
    await seed.close();

    for (let n = 1; n <= 12; n += 1) {
      const pg = await openCluster(dir);
      await pg.query("update projects set description = $1 where id = $2 and user_id = $3", [
        `n=${n}`,
        id,
        "user-sandbox",
      ]);
      const rows = await pg.query<{ description: string; name: string }>(
        "select name, description from projects where id = $1 and user_id = $2",
        [id, "user-sandbox"],
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0]?.name, "Stress Keep");
      assert.equal(rows.rows[0]?.description, `n=${n}`);
      await pg.close();
    }
  });

  it("keeps account API keys after close and reopen", async () => {
    const keysDir = mkdtempSync(join(tmpdir(), "cb-pglite-keys-"));
    try {
      const schema = `
        create table if not exists account_settings (
          user_id text primary key,
          provider text not null default 'openrouter',
          openrouter_key text not null default '',
          openrusrouter_key text not null default '',
          gpt_model text not null,
          grok_model text not null,
          claude_model text not null,
          max_cost_usd numeric not null default 1,
          updated_at text not null
        );
      `;
      const first = new PGlite({ dataDir: keysDir, relaxedDurability: false });
      await first.waitReady;
      await first.exec(schema);
      await first.query(
        `insert into account_settings (
          user_id, provider, openrouter_key, openrusrouter_key, gpt_model, grok_model, claude_model, max_cost_usd, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          "user-sandbox",
          "openrouter",
          "sk-or-v1-persist-keep",
          "",
          "openai/gpt-5",
          "x-ai/grok-4",
          "anthropic/claude-sonnet-4",
          1,
          "2026-09-04T09:20:00.000Z",
        ],
      );
      await first.exec("checkpoint");
      await first.close();

      const second = new PGlite({ dataDir: keysDir, relaxedDurability: false });
      await second.waitReady;
      await second.exec(schema);
      const rows = await second.query<{ openrouter_key: string; provider: string }>(
        "select provider, openrouter_key from account_settings where user_id = $1",
        ["user-sandbox"],
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0]?.provider, "openrouter");
      assert.equal(rows.rows[0]?.openrouter_key, "sk-or-v1-persist-keep");
      await second.close();
    } finally {
      rmSync(keysDir, { recursive: true, force: true });
    }
  });
});
