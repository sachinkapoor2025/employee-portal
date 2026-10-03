const assert = require("assert");
const {
  generateProjectCode,
  slugifyProjectName,
  parseProjectType,
  parseProjectCode,
  resolveProjectCode,
  isProjectClassified,
  decorateProject,
  PROJECT_TYPE_REQUIRED,
  INVALID_PROJECT_TYPE,
  INVALID_PROJECT_CODE,
  CODE_PREFIX_MISMATCH,
  UNABLE_TO_GENERATE_CODE,
} = require("./projectCode");

function run() {
  assert.strictEqual(generateProjectCode("INTERNAL", "DGV Portal"), "DGV-INT-DGV_PORTAL");
  assert.strictEqual(generateProjectCode("EXTERNAL", "BlossomPot"), "DGV-EXT-BLOSSOMPOT");
  assert.strictEqual(
    generateProjectCode("EXTERNAL", "HalloweenReady"),
    "DGV-EXT-HALLOWEENREADY"
  );
  assert.strictEqual(
    generateProjectCode("external", "Maharaja Chef"),
    "DGV-EXT-MAHARAJA_CHEF"
  );
  assert.strictEqual(
    generateProjectCode("INTERNAL", "  dgv   portal  "),
    "DGV-INT-DGV_PORTAL"
  );
  assert.strictEqual(
    generateProjectCode("INTERNAL", "DGV-Portal / v2"),
    "DGV-INT-DGV_PORTAL_V2"
  );
  assert.strictEqual(slugifyProjectName("__Portal__"), "PORTAL");
  assert.strictEqual(slugifyProjectName("a---b"), "A_B");
  assert.strictEqual(generateProjectCode("INTERNAL", "   "), "");
  assert.strictEqual(generateProjectCode("NOPE", "Portal"), "");
  assert.strictEqual(generateProjectCode("INTERNAL", "!!!"), "");

  assert.deepStrictEqual(parseProjectType(""), { ok: true, value: "" });
  assert.deepStrictEqual(parseProjectType("", { required: true }), {
    ok: false,
    error: PROJECT_TYPE_REQUIRED,
  });
  assert.deepStrictEqual(parseProjectType("internal"), {
    ok: true,
    value: "INTERNAL",
  });
  assert.strictEqual(parseProjectType("OTHER").ok, false);
  assert.strictEqual(parseProjectType("OTHER").error, INVALID_PROJECT_TYPE);

  assert.strictEqual(parseProjectCode("DGV-INT-PORTAL", "INTERNAL").ok, true);
  assert.strictEqual(parseProjectCode("dgv-int-portal", "INTERNAL").value, "DGV-INT-PORTAL");
  assert.strictEqual(parseProjectCode("DGV-EXT-PORTAL", "INTERNAL").error, CODE_PREFIX_MISMATCH);
  assert.strictEqual(parseProjectCode("DGV-INT-", "INTERNAL").error, INVALID_PROJECT_CODE);
  assert.strictEqual(parseProjectCode("DGV-INT-_PORTAL", "INTERNAL").error, INVALID_PROJECT_CODE);
  assert.strictEqual(parseProjectCode("DGV-INT-PORTAL_", "INTERNAL").error, INVALID_PROJECT_CODE);

  assert.strictEqual(
    resolveProjectCode({ type: "INTERNAL", name: "???" }).error,
    UNABLE_TO_GENERATE_CODE
  );
  assert.strictEqual(
    resolveProjectCode({
      type: "EXTERNAL",
      name: "Old",
      manualCode: "DGV-EXT-BLOSSOMPOT",
    }).value,
    "DGV-EXT-BLOSSOMPOT"
  );

  assert.strictEqual(isProjectClassified({ projectType: "INTERNAL", projectCode: "DGV-INT-X" }), true);
  assert.strictEqual(isProjectClassified({ name: "Legacy" }), false);
  assert.strictEqual(isProjectClassified({ projectType: "INTERNAL" }), false);

  const unclassified = decorateProject({ name: "Portal", projectId: "p1" });
  assert.strictEqual(unclassified.classified, false);
  assert.strictEqual(unclassified.projectType, null);
  assert.strictEqual(unclassified.projectCode, null);

  const classified = decorateProject({
    name: "Portal",
    projectType: "internal",
    projectCode: "DGV-INT-PORTAL",
  });
  assert.strictEqual(classified.classified, true);
  assert.strictEqual(classified.projectType, "INTERNAL");
  assert.strictEqual(classified.projectCode, "DGV-INT-PORTAL");

  console.log("projectCode tests passed");
}

run();
