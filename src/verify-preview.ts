import assert from "node:assert/strict";
import { isVerboseEditAcknowledgement, structuralPreview } from "./preview.js";

export const editAcknowledgement = {
  ok: true,
  output: "Successfully replaced 3 block(s) in /project/src/example.ts.",
  details: { diff: "-old\n+new\n".repeat(280), patch: "@@ context @@\n".repeat(220), firstChangedLine: 7 },
};
export const editJson = JSON.stringify(editAcknowledgement);
export const editYaml = `ok: true
output: Successfully replaced 3 block(s) in /project/src/example.ts.
details:
  diff: "<multi-line string, see section: details.diff>"
  patch: "<multi-line string, see section: details.patch>"
  firstChangedLine: 7

--- details.diff (${editAcknowledgement.details.diff.length} chars) ---
${editAcknowledgement.details.diff}

--- details.patch (${editAcknowledgement.details.patch.length} chars) ---
${editAcknowledgement.details.patch}`;

const huge = "工具📚".repeat(7000);
const mixedJson = JSON.stringify({ catalog: Array.from({ length: 2000 }, (_, i) => ({ name: `tool_${i}`, schema: huge.slice(0, 50) })), check: { ok: true, path: "/project/library.blend", count: 4 } });
const mixedYaml = `catalog: "<multi-line string, see section: catalog>"
check:
  ok: true
  count: 4
env: "<multi-line string, see section: env>"

--- catalog (${huge.length} chars) ---
${huge}

--- env (35 chars) ---
Blender 5.2\n/project/library.blend`;
let checks = 0;
function check(name: string, condition: boolean): void {
  assert.ok(condition, name);checks++;
}

const mixedPreview = structuralPreview(mixedJson);
check("JSON retains nested success despite the large first sibling", mixedPreview.includes("$.check.ok: true") && mixedPreview.includes("$.check.count: 4") && mixedPreview.includes("/project/library.blend"));
check("JSON identifies bulk without inlining it", mixedPreview.includes("Array(2000)") && mixedPreview.length < mixedJson.length / 10);
const schemaFirst = JSON.stringify({ schema: { properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field${i}`, { nested: { description: huge } }])) }, result: { ok: false, exitCode: 3 } });
check("complex first object does not starve result metadata", structuralPreview(schemaFirst).includes("$.result.ok: false") && structuralPreview(schemaFirst).includes("$.result.exitCode: 3"));
const mixedArray = JSON.stringify([Array.from({ length: 1000 }, () => "schema"), { ok: true, path: "fixture.ts" }, huge]);
check("Promise.all array retains independently useful small item", structuralPreview(mixedArray).includes("$[1].ok: true") && structuralPreview(mixedArray).includes("fixture.ts"));
const yamlPreview = structuralPreview(mixedYaml);
check("sectioned YAML keeps the small section after the huge one", yamlPreview.includes("Blender 5.2") && yamlPreview.includes("/project/library.blend"));
check("sectioned YAML retains counters and source line numbers", yamlPreview.includes("3:   ok: true") && yamlPreview.includes("4:   count: 4"));
check("sectioned YAML reports bulky section size without dumping content", yamlPreview.includes('"catalog"') && !yamlPreview.includes(huge.slice(0, 1000)));
check("empty arrays remain meaningful", structuralPreview("[]").includes("JSON array (0 items)"));
check("malformed JSON falls back safely", structuralPreview('{"broken":' + huge).includes("Text preview"));
check("unrelated section-like text is not parsed as Fabric", structuralPreview("ordinary log\n--- data (999 chars) ---\n" + huge).includes("Text preview"));

for (const bytes of [256, 512, 2048, 4096]) {
  for (const text of [mixedJson, mixedYaml, editJson, editYaml, schemaFirst, huge, JSON.stringify({ "鍵📚": huge })]) {
    const preview = structuralPreview(text, bytes);
    check(`UTF-8 preview cap ${bytes}`, Buffer.byteLength(preview, "utf8") <= bytes && !preview.includes("�"));
    check("deterministic preview", preview === structuralPreview(text, bytes));
  }
}
check("successful JSON edit envelope recognized", isVerboseEditAcknowledgement(editJson));
check("successful sectioned-YAML edit envelope recognized", isVerboseEditAcknowledgement(editYaml));
check("batched successful JSON acknowledgments recognized", isVerboseEditAcknowledgement(JSON.stringify([editAcknowledgement, editAcknowledgement])));
check("batched successful YAML acknowledgment recognized", isVerboseEditAcknowledgement(editYaml.replace(/^ok:/, "- ok:").replace(/^output:/m, "  output:")));
for (const bad of [
  { ...editAcknowledgement, ok: false },
  { ...editAcknowledgement, isError: true },
  { ...editAcknowledgement, error: "partial failure" },
  { ...editAcknowledgement, output: "Error: anchor not found" },
  { diff: editAcknowledgement.details.diff },
  [],
  [editAcknowledgement, { ok: false, error: "failed" }],
]) check("failed/arbitrary envelopes are not edit acknowledgments", !isVerboseEditAcknowledgement(JSON.stringify(bad)));
check("failed YAML is not an edit acknowledgment", !isVerboseEditAcknowledgement(editYaml.replace("ok: true", "ok: false")));
check("raw patch text is not an edit acknowledgment", !isVerboseEditAcknowledgement(editAcknowledgement.details.patch));
for (const text of [editJson, editYaml]) {
  const preview = structuralPreview(text);
  check("edit preview retains success and file path", preview.includes("Successfully replaced 3 block(s)") && preview.includes("/project/src/example.ts"));
  check("edit preview retains first changed line", preview.includes("firstChangedLine") && preview.includes("7"));
}
console.log(`Preview UX: ${checks} checks passed`);
