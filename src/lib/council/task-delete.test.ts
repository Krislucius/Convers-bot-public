import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { t } from "../i18n/catalog.ts";

const storeSrc = readFileSync(fileURLToPath(new URL("./store.ts", import.meta.url)), "utf8");
const accountSrc = readFileSync(fileURLToPath(new URL("./account.server.ts", import.meta.url)), "utf8");
const accountFnSrc = readFileSync(fileURLToPath(new URL("./account.ts", import.meta.url)), "utf8");
const pageSrc = readFileSync(fileURLToPath(new URL("../../routes/p.$projectId.index.tsx", import.meta.url)), "utf8");

describe("task delete", () => {
  it("persists a user-scoped cascade, not a client hide", () => {
    assert.match(storeSrc, /export function deleteTask\(id: string\)/);
    assert.match(storeSrc, /stopCouncilRun\(id\)/);
    assert.match(storeSrc, /persistAccountDeleteTask\(\{ data: \{ taskId: id \} \}\)/);
    assert.match(storeSrc, /responses: memory\.responses\.filter\(\(row\) => row\.taskId !== id\)/);
    assert.match(storeSrc, /results: memory\.results\.filter\(\(row\) => row\.taskId !== id\)/);
    assert.match(storeSrc, /artifacts: memory\.artifacts\.filter\(\(row\) => row\.taskId !== id\)/);
    assert.match(accountFnSrc, /export const persistAccountDeleteTask/);
    assert.match(accountFnSrc, /authMiddleware/);
    assert.match(accountSrc, /export async function persistDeleteTask\(userId: string, taskId: string\)/);
    assert.match(accountSrc, /delete from agent_responses where user_id = \$\{userId\} and task_id = \$\{taskId\}/);
    assert.match(accountSrc, /delete from council_results where user_id = \$\{userId\} and task_id = \$\{taskId\}/);
    assert.match(accountSrc, /delete from artifacts where user_id = \$\{userId\} and task_id = \$\{taskId\}/);
    assert.match(accountSrc, /delete from council_runs where user_id = \$\{userId\} and task_id = \$\{taskId\}/);
    assert.match(accountSrc, /delete from tasks where user_id = \$\{userId\} and id = \$\{taskId\}/);
  });

  it("puts a delete control on every task row", () => {
    assert.match(pageSrc, /<TaskRow key=\{task\.id\} task=\{task\}/);
    assert.match(pageSrc, /onClick=\{\(\) => deleteTask\(task\.id\)\}/);
    assert.match(pageSrc, /t\("task\.delete"\)/);
    assert.match(pageSrc, /t\("task\.deleteConfirm"\)/);
  });

  it("labels delete in English and Russian", () => {
    assert.equal(t("task.delete", "en"), "Delete");
    assert.equal(t("task.deleteYes", "en"), "Delete task");
    assert.equal(t("task.delete", "ru"), "Удалить");
    assert.equal(t("task.deleteYes", "ru"), "Удалить задачу");
    assert.equal(t("task.deleteCancel", "ru"), "Отмена");
  });
});
