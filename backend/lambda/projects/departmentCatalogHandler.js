const { getUser } = require("../common/auth");
const { json } = require("../common/response");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

const departments = require("./departments");
const designations = require("./departmentDesignations");

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");

  try {
    const user = getUser(event);
    const path = event.path || "";
    const method = event.httpMethod;
    const body = event.body ? JSON.parse(event.body) : {};

    const ctx = {
      user,
      body,
      ddb,
      tableName: process.env.WORK_TABLE,
      accessTable: process.env.USER_ACCESS_TABLE,
      profileTable: process.env.USER_PROFILE_TABLE,
    };

    if (departments.publicDepartmentsPathMatch(path) && method === "GET") {
      const result = await departments.handleListPublicDepartments(ctx);
      return json(result.statusCode, result.body);
    }

    if (departments.adminDepartmentsPathMatch(path) && method === "GET") {
      const result = await departments.handleListDepartments(ctx);
      return json(result.statusCode, result.body);
    }

    if (departments.adminDepartmentsPathMatch(path) && method === "POST") {
      const result = await departments.handleCreateDepartment(ctx);
      return json(result.statusCode, result.body);
    }

    const designationList = designations.designationListPathMatch(
      path,
      event.pathParameters
    );
    if (designationList && !designationList.ok) {
      return json(400, { error: "Invalid path parameter." });
    }
    if (designationList?.value && method === "GET") {
      const result = await designations.handleListDesignations({
        ...ctx,
        departmentId: designationList.value,
        admin: /\/admin\/departments\//.test(path),
      });
      return json(result.statusCode, result.body);
    }
    if (
      designationList?.value &&
      method === "POST" &&
      /\/admin\/departments\//.test(path)
    ) {
      const result = await designations.handleCreateDesignation({
        ...ctx,
        departmentId: designationList.value,
      });
      return json(result.statusCode, result.body);
    }

    const designationStatus = designations.designationStatusPathMatch(
      path,
      event.pathParameters
    );
    if (designationStatus && !designationStatus.ok) {
      return json(400, { error: "Invalid path parameter." });
    }
    if (designationStatus?.designationId && method === "POST") {
      const result = await designations.handleDesignationStatus({
        ...ctx,
        departmentId: designationStatus.departmentId,
        designationId: designationStatus.designationId,
      });
      return json(result.statusCode, result.body);
    }

    const designationId = designations.designationIdPathMatch(
      path,
      event.pathParameters
    );
    if (designationId && !designationId.ok) {
      return json(400, { error: "Invalid path parameter." });
    }
    if (designationId?.designationId && method === "PATCH") {
      const result = await designations.handlePatchDesignation({
        ...ctx,
        departmentId: designationId.departmentId,
        designationId: designationId.designationId,
      });
      return json(result.statusCode, result.body);
    }

    const departmentStatus = departments.departmentStatusPathMatch(
      path,
      event.pathParameters
    );
    if (departmentStatus && !departmentStatus.ok) {
      return json(400, { error: "Invalid path parameter." });
    }
    if (departmentStatus?.value && method === "POST") {
      const result = await departments.handleDepartmentStatus({
        ...ctx,
        departmentId: departmentStatus.value,
      });
      return json(result.statusCode, result.body);
    }

    const departmentId = departments.departmentIdPathMatch(
      path,
      event.pathParameters
    );
    if (departmentId && !departmentId.ok) {
      return json(400, { error: "Invalid path parameter." });
    }
    if (departmentId?.value && method === "PATCH") {
      const result = await departments.handlePatchDepartment({
        ...ctx,
        departmentId: departmentId.value,
      });
      return json(result.statusCode, result.body);
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("Department catalog handler error:", err);
    return json(500, { error: "Internal server error" });
  }
};
