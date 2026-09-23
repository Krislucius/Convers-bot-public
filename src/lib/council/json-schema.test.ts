import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJson, makeCreateSchema, makeDecideSchema, makeReviewSchema } from "./protocol.ts";
import { operatorRecordJson } from "./operator-record.ts";
import {
  acceptSynthesisJson,
  collectSchemaIssues,
  extractJsonValue,
  inspectSynthesis,
  invalidSynthesisMessage,
  jsonSchemaFromResponseFormat,
  synthesisRepairPrompt,
} from "./json-schema.ts";

const decide = {
  status: "APPROVED",
  consensus: ["ok"],
  disagreements: [],
  blockers: [],
  recommendation: "go",
  agent_positions: { m1: "ok" },
  decision: "keep",
  alternatives: [],
  rationale: "because",
  dissent: [],
  evidence: [],
  risks: [],
  citations: [],
  operator_record: operatorRecordJson(),
};

const create = {
  ...decide,
  status: "READY_FOR_REVIEW",
  artifact: {
    type: "SPECIFICATION",
    title: "Spec",
    version: "1.0",
    content: "# Spec",
    evidenceLabels: [{ claim: "ok", status: "UNKNOWN", citation: "" }],
  },
};

describe("JSON schema validation", () => {
  it("extracts a verdict object from thinking-model wrapping", () => {
    const wrapped = `<think>I should emit { "status": "nope" } first.</think>\n\`\`\`json\n${JSON.stringify(decide)}\n\`\`\`\n`;
    const extracted = extractJsonValue(wrapped);
    assert.equal(extracted.error, null);
    assert.equal(extracted.value?.status, "APPROVED");
    const parsed = parseJson(wrapped);
    assert.equal(parsed?.status, "APPROVED");
    assert.equal(inspectSynthesis(wrapped, "DECIDE").ok, true);
  });

  it("rejects missing status and CREATE without artifact", () => {
    const missingStatus = acceptSynthesisJson({ recommendation: "go" }, "DECIDE").map((row) => row.path);
    assert.ok(missingStatus.includes("/status"));
    assert.ok(missingStatus.includes("/operator_record"));
    const issues = acceptSynthesisJson({ status: "APPROVED" }, "CREATE");
    assert.ok(issues.some((row) => row.path === "/artifact"));
    assert.ok(issues.some((row) => row.path.startsWith("/operator_record")));
    assert.match(invalidSynthesisMessage(issues), /JSON schema invalid/);
  });

  it("walks the provider CREATE schema", () => {
    const schema = jsonSchemaFromResponseFormat(makeCreateSchema(["lead"]));
    const issues = collectSchemaIssues({ status: "APPROVED" }, schema);
    assert.ok(issues.some((row) => row.path === "/artifact" && row.message === "required"));
  });

  it("accepts READY_FOR_REVIEW on CREATE", () => {
    assert.deepEqual(acceptSynthesisJson(create, "CREATE"), []);
    assert.equal(parseJson(JSON.stringify(create))?.status, "READY_FOR_REVIEW");
    const schema = jsonSchemaFromResponseFormat(makeCreateSchema(["lead"]));
    const statusEnum = (schema?.properties as { status?: { enum?: string[] } })?.status?.enum ?? [];
    assert.ok(statusEnum.includes("READY_FOR_REVIEW"));
  });

  it("builds a repair prompt from schema issues", () => {
    const prompt = synthesisRepairPrompt([{ path: "/status", message: "required" }], "create_artifact_result");
    assert.match(prompt, /create_artifact_result/);
    assert.match(prompt, /\/status: required/);
    assert.match(prompt, /JSON object only/);
  });

  it("review schema requires review_verdict", () => {
    const schema = jsonSchemaFromResponseFormat(makeReviewSchema(["lead"]));
    const issues = collectSchemaIssues({ status: "PATCH" }, schema);
    assert.ok(issues.some((row) => row.path === "/review_verdict"));
  });

  it("decide schema requires decision", () => {
    const schema = jsonSchemaFromResponseFormat(makeDecideSchema(["lead"]));
    const issues = collectSchemaIssues({ status: "APPROVED" }, schema);
    assert.ok(issues.some((row) => row.path === "/decision"));
  });

  it("requires operator_record.summary for a human Decision Record", () => {
    const without = acceptSynthesisJson({ ...decide, operator_record: undefined }, "DECIDE");
    assert.ok(without.some((row) => row.path === "/operator_record"));
    const empty = acceptSynthesisJson({ ...decide, operator_record: { summary: "" } }, "DECIDE");
    assert.ok(empty.some((row) => row.path === "/operator_record/summary"));
    assert.deepEqual(acceptSynthesisJson(decide, "DECIDE"), []);
    const schema = jsonSchemaFromResponseFormat(makeReviewSchema(["lead"]));
    assert.ok(schema && "operator_record" in ((schema.properties as Record<string, unknown>) ?? {}));
    assert.ok((schema?.required as string[]).includes("operator_record"));
  });
});
