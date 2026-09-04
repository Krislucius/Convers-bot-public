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
});
