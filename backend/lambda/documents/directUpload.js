const { randomUUID } = require("crypto");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { json } = require("../common/response");
const { fileBlobKey } = require("../common/documentsStorage");
const {
  MAX_BYTES,
  sanitizeFileName,
  validateFile,
  resolvedContentType,
  prepareUploadFiles,
} = require("./folderRules");

async function createDirectUploadUrl(s3, body, { expiresIn } = {}) {
  const fileName = sanitizeFileName(body.fileName);
  const fileSize = Number(body.fileSize);
  const contentType = resolvedContentType(fileName, body.contentType);
  const error = validateFile({ fileName, fileSize });
  if (error) return json(400, { error });
  const bucket = process.env.DOCUMENTS_BUCKET;
  if (!bucket) return json(500, { error: "Documents bucket not configured" });
  const fileId = randomUUID();
  const s3Key = fileBlobKey(fileId);
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ContentType: contentType,
    }),
    { expiresIn }
  );
  return json(200, {
    uploadUrl,
    fileId,
    s3Key,
    fileName,
    contentType,
    fileSize,
    maxBytes: MAX_BYTES,
  });
}

async function rollbackCreatedBlobs(storage, uploaded) {
  await Promise.all(
    (uploaded || [])
      .filter((file) => file.createdBlob && file.fileId)
      .map((file) => storage.deleteFileBlob(file.fileId).catch(() => {}))
  );
}

async function materializeUploads(storage, user, files, { description, uploadedAt }) {
  const { prepared, errors } = prepareUploadFiles(files);
  if (errors.length) {
    return {
      error: json(400, {
        error: "Some files failed validation.",
        files: errors,
      }),
    };
  }

  const uploaded = [];
  try {
    for (const file of prepared) {
      if (file.body) {
        const blob = await storage.putFileBlob({
          body: file.body,
          contentType: file.contentType,
          fileName: file.fileName,
          uploadedBy: user.email,
          uploadedAt,
          description: file.description || description,
          size: file.fileSize,
        });
        uploaded.push({ ...file, ...blob, createdBlob: true });
        continue;
      }

      let head;
      try {
        head = await storage.headFileBlob(file.fileId);
      } catch (err) {
        if (String(err.message || "").startsWith("Invalid ")) {
          return {
            error: json(400, {
              error: "Some files failed validation.",
              files: [
                {
                  index: file.index,
                  fileName: file.fileName,
                  error: "Invalid file.",
                },
              ],
            }),
            uploaded,
          };
        }
        throw err;
      }
      if (!head) {
        return {
          error: json(400, {
            error: "Some files failed validation.",
            files: [
              {
                index: file.index,
                fileName: file.fileName,
                error: "File was not uploaded. Please try again.",
              },
            ],
          }),
          uploaded,
        };
      }
      if (
        Number.isFinite(Number(head.contentLength)) &&
        Number(head.contentLength) !== file.fileSize
      ) {
        return {
          error: json(400, {
            error: "Some files failed validation.",
            files: [
              {
                index: file.index,
                fileName: file.fileName,
                error: "Uploaded file size does not match.",
              },
            ],
          }),
          uploaded,
        };
      }
      uploaded.push({ ...file, createdBlob: false });
    }
  } catch (err) {
    await rollbackCreatedBlobs(storage, uploaded);
    throw err;
  }

  return { uploaded };
}

module.exports = {
  createDirectUploadUrl,
  materializeUploads,
  rollbackCreatedBlobs,
};
