const { GetCommand, PutCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");

const ORG_DESIGNATION_PK = "ENTITY#ORG_DESIGNATION";
const ORG_DESIGNATION_NAME_PK = "ENTITY#ORG_DESIGNATION_NAME";
const DEPARTMENT_ENTITY_PK = "ENTITY#DEPARTMENT";
const LEGACY_DESIGNATION_PK = "ENTITY#DESIGNATION";
const COST_RATES_SK = "COST_RATES";

const TRACKS = [
  [
    "it-software-development",
    [
      ["Software Development", ["Technical Lead", "Senior Software Developer", "Software Developer", "Junior Software Developer", "Intern Software Developer"]],
      ["Software Testing / QA", ["QA Lead", "Senior QA Engineer", "QA Engineer", "Junior QA Engineer", "QA Intern"]],
      ["UI/UX Design", ["Design Lead", "Senior UI/UX Designer", "UI/UX Designer", "Junior UI/UX Designer", "UI/UX Design Intern"]],
    ],
  ],
  [
    "ai-automation",
    [
      ["AI / Machine Learning", ["AI Lead", "Senior AI Engineer", "AI Engineer", "Junior AI Engineer", "AI Intern"]],
      ["Automation", ["Automation Lead", "Senior Automation Engineer", "Automation Engineer", "Junior Automation Engineer", "Automation Intern"]],
    ],
  ],
  [
    "seo-digital-marketing",
    [
      ["SEO", ["SEO Lead", "Senior SEO Specialist", "SEO Specialist", "Junior SEO Specialist", "SEO Intern"]],
      ["Digital Marketing", ["Digital Marketing Lead", "Senior Digital Marketing Specialist", "Digital Marketing Specialist", "Junior Digital Marketing Specialist", "Digital Marketing Intern"]],
      ["Content", ["Content Lead", "Senior Content Writer", "Content Writer", "Junior Content Writer", "Content Intern"]],
    ],
  ],
  [
    "ecommerce-product-operations",
    [
      ["Ecommerce Operations", ["Ecommerce Operations Lead", "Senior Ecommerce Operations Specialist", "Ecommerce Operations Specialist", "Junior Ecommerce Operations Specialist", "Ecommerce Operations Intern"]],
      ["Product Management", ["Product Manager", "Associate Product Manager", "Junior Product Manager", "Product Management Intern"]],
    ],
  ],
  [
    "sales-business-development",
    [
      ["Sales", ["Sales Lead", "Senior Sales Executive", "Sales Executive", "Junior Sales Executive", "Sales Intern"]],
      ["Business Development", ["Business Development Lead", "Senior Business Development Executive", "Business Development Executive", "Junior Business Development Executive", "Business Development Intern"]],
    ],
  ],
  [
    "project-management-client-services",
    [
      ["Project Management", ["Project Manager", "Associate Project Manager", "Project Coordinator", "Project Management Intern"]],
      ["Client Services", ["Client Services Lead", "Senior Client Services Executive", "Client Services Executive", "Junior Client Services Executive", "Client Services Intern"]],
    ],
  ],
  [
    "human-resources-administration",
    [
      ["Human Resources", ["HR Manager", "HR Executive", "Junior HR Executive", "HR Intern"]],
      ["Administration", ["Administration Manager", "Administration Executive", "Junior Administration Executive", "Administration Intern"]],
    ],
  ],
  [
    "finance-accounting",
    [
      ["Finance", ["Finance Manager", "Finance Executive", "Junior Finance Executive", "Finance Intern"]],
      ["Accounting", ["Accounting Lead", "Senior Accountant", "Accountant", "Junior Accountant", "Accounting Intern"]],
    ],
  ],
];

function slug(value) {
  return String(value || "")
    .trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/&/g, " and ")
    .replace(/[/.]/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function nameKey(name) {
  return String(name || "")
    .trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function designationIdFor(departmentId, track, name) {
  return `${departmentId}--${slug(track)}--${slug(name)}`;
}

const SEED_DESIGNATIONS = TRACKS.flatMap(([departmentId, tracks]) =>
  tracks.flatMap(([track, names], trackIndex) =>
    names.map((name, index) => ({
      designationId: designationIdFor(departmentId, track, name),
      departmentId,
      track,
      trackSort: trackIndex + 1,
      sortOrder: index + 1,
      name,
      nameKey: nameKey(name),
    }))
  )
);

function designationSk(id) {
  return `DESIGNATION#${id}`;
}

function positiveRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function planDesignationSeed({ departments = [], designations = [] }) {
  const departmentIds = new Set(
    departments.map((item) => item.departmentId).filter(Boolean)
  );
  const missingDepartments = [
    ...new Set(SEED_DESIGNATIONS.map((row) => row.departmentId)),
  ].filter((id) => !departmentIds.has(id));
  const existing = new Map(
    designations
      .filter((item) => item?.designationId)
      .map((item) => [item.designationId, item])
  );
  const create = [];
  const skip = [];
  if (!missingDepartments.length) {
    for (const seed of SEED_DESIGNATIONS) {
      if (existing.has(seed.designationId)) skip.push(seed);
      else create.push(seed);
    }
  }
  return { missingDepartments, create, skip };
}

function planLegacyCostingMigration({ legacyItems = [], orgItems = [] }) {
  const byName = new Map();
  for (const org of orgItems) {
    if (org?.type && org.type !== "ORG_DESIGNATION") continue;
    const key = nameKey(org?.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(org);
  }
  const pendingMatches = [];
  const ambiguous = [];
  const unmatched = [];
  const alreadyMigrated = [];
  for (const legacy of legacyItems) {
    if (!legacy?.designationId || legacy.type === "ORG_DESIGNATION") continue;
    const row = {
      designationId: legacy.designationId,
      name: legacy.name || "",
      internalHourlyRate: positiveRate(legacy.internalHourlyRate),
      externalHourlyRate: positiveRate(legacy.externalHourlyRate),
    };
    if (legacy.migratedToDesignationId) {
      alreadyMigrated.push({
        ...row,
        migratedToDesignationId: legacy.migratedToDesignationId,
      });
      continue;
    }
    const hits = byName.get(nameKey(legacy.name)) || [];
    if (hits.length === 1) {
      pendingMatches.push({
        ...row,
        action: "manual-review",
        reason:
          "An exact name also exists on a department designation. The name is not a link.",
      });
    } else if (hits.length > 1) {
      ambiguous.push({
        ...row,
        reason: "More than one department designation uses this name.",
        candidates: hits.map((item) => ({
          designationId: item.designationId,
          departmentId: item.departmentId,
          track: item.track || "",
          name: item.name,
        })),
      });
    } else {
      unmatched.push({
        ...row,
        reason: "No department designation has this exact name.",
      });
    }
  }
  return { pendingMatches, ambiguous, unmatched, alreadyMigrated };
}

async function getItem(ddb, tableName, pk, sk) {
  const res = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk } })
  );
  return res.Item || null;
}

async function applyDesignationSeed({
  ddb,
  tableName,
  plan,
  nowIso,
  actor = "designation-seed",
}) {
  if (!plan || plan.missingDepartments?.length) {
    return { created: [], skipped: [], blocked: plan?.missingDepartments || [] };
  }
  const created = [];
  const skipped = [];
  const now = nowIso || new Date().toISOString();
  for (const seed of [...plan.create, ...plan.skip]) {
    const existing = await getItem(
      ddb,
      tableName,
      ORG_DESIGNATION_PK,
      designationSk(seed.designationId)
    );
    if (existing) {
      skipped.push(seed.designationId);
      continue;
    }
    const item = {
      PK: ORG_DESIGNATION_PK,
      SK: designationSk(seed.designationId),
      type: "ORG_DESIGNATION",
      designationId: seed.designationId,
      departmentId: seed.departmentId,
      track: seed.track,
      trackSort: seed.trackSort,
      sortOrder: seed.sortOrder,
      name: seed.name,
      nameKey: seed.nameKey,
      status: "ACTIVE",
      internalHourlyRate: null,
      externalHourlyRate: null,
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                PK: ORG_DESIGNATION_NAME_PK,
                SK: `NAME#${seed.departmentId}#${seed.nameKey}`,
                type: "ORG_DESIGNATION_NAME",
                departmentId: seed.departmentId,
                designationId: seed.designationId,
                nameKey: seed.nameKey,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      })
    );
    created.push(seed.designationId);
  }
  return { created, skipped, blocked: [] };
}

async function applyLegacyCostingMigration({ plan }) {
  // Name-only matches are reported for manual review. They are not written:
  // a shared name does not prove the department or the employee assignment.
  return {
    copied: [],
    relinked: [],
    manual: [
      ...(plan?.pendingMatches || []),
      ...(plan?.ambiguous || []),
      ...(plan?.unmatched || []),
    ],
  };
}

module.exports = {
  COST_RATES_SK,
  DEPARTMENT_ENTITY_PK,
  LEGACY_DESIGNATION_PK,
  ORG_DESIGNATION_PK,
  SEED_DESIGNATIONS,
  applyDesignationSeed,
  applyLegacyCostingMigration,
  designationIdFor,
  nameKey,
  planDesignationSeed,
  planLegacyCostingMigration,
  slug,
};
