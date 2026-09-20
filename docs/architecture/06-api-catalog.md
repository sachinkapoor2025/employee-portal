# 06 — API catalog

**Last verified:** 20 September 2026  
**Sources:** `backend/template.yaml` Events (`Type: Api`), matching Lambda handlers  

**Base path:** `https://{api-id}.execute-api.ap-south-1.amazonaws.com/prod`  
**Auth (all methods below unless noted):** SAM `Auth.DefaultAuthorizer: CognitoAuthorizer`. OPTIONS preflight: authorizer not applied (`AddDefaultAuthorizerToCorsPreflight: false`).  
**Unauthenticated HTTP APIs:** none declared in SAM.  
**Error JSON:** commonly `{ "error": "..." }` (`common/response.js`). Some handlers use `{ "message": "..." }` (profile, skills, training list, addTraining).  
**Gateway 401:** invalid/missing JWT (not formatted by Lambda).

Role column: **JWT** = any valid token. **Admin group** = `user.isAdmin` (Cognito group `Admin`). **Unverified extra** = handler does not check admin.

---

## AccessFunction — `lambda/access/handler.js`

| Method | Path | AuthZ | Request | Response (verified) |
|---|---|---|---|---|
| GET | `/access` | JWT | — | `{ access, role }` (`ADMIN`/`USER`/`PENDING`/`BLOCKED`/`DENIED`) |
| POST | `/request-access` | JWT | `{}` | `{ access, role, message }` |

Errors: 500 `{ error: "Internal server error" }`; 405 method.

---

## AdminFunction — `lambda/admin/handler.js`

| Method | Path | AuthZ | Request | Response |
|---|---|---|---|---|
| GET | `/admin/users` | Admin group | — | user list merged with profiles |
| POST | `/admin/users` | Admin group | `{ email, action, role? }` | depends on action |

Verified POST `action` values: `changeRole`, `resetPassword`, `delete`, plus status lifecycle actions used by `updateUserStatus` in `api.js` (handler branches for activate/block — see file). Super Admin required for lifecycle/delete. `resetPassword` returns `{ message, temporaryPassword }`.

---

## UserProfile / UserProfileFunction / ImageUpload

| Method | Path | Lambda | AuthZ | Notes |
|---|---|---|---|---|
| GET | `/user/profile` | UserProfile | JWT | Email from claims if no query |
| GET | `/admin/getUserProfile` | UserProfile | JWT | Query `email` **not admin-gated in handler** |
| POST | `/admin/save-user-profile` | UserProfileFunction | JWT; create requires Admin group; EDIT self allowed | `{ mode, email, role?, profile }` |
| POST | `/getProfileImageUploadUrl` | ImageUploadFunction | JWT | Presign; extra ACL **not fully catalogued here** |

Profile GET 400 `{ message: "Email is required" }`; 500 `{ message: "Failed to fetch profile" }`.

---

## ActivityFunction — `lambda/activity/handler.js`

| Method | Path | AuthZ | Query/body | Response |
|---|---|---|---|---|
| POST | `/activity` | JWT | `{ type, page, device, userAgent, sessionMinutes, ... }` | write event + summary |
| GET | `/activity/today` | JWT | `date?` | own events + summary |
| GET | `/admin/activity` | Admin group | `date?`, `email?` | org or per-user |
| GET | `/admin/dashboard` | Admin group | — | `{ date, stats, recentActivity, overdueTasks }` |

---

## AttendanceFunction — `lambda/attendance/handler.js`

| Method | Path | AuthZ | Request | Notes |
|---|---|---|---|---|
| GET | `/attendance` | JWT | range query via `startDate`/`endDate`/`email` (admin email) | |
| POST | `/attendance` | JWT | `{ action: "checkIn"|"checkOut", date, checkInTime/checkOutTime }` or week records array | 409 if locked |
| GET | `/admin/attendance-activity` | Admin group | pagination `page`/`pageSize` | `{ items, page, pageSize, total, totalPages }` |

---

## WorkFunction — `lambda/work/handler.js` (**legacy**)

| Method | Path | AuthZ | Response |
|---|---|---|---|
| GET | `/work` | JWT | Array of tasks assigned to caller (not the `{ tasks, zoneCounts }` shape) |

---

## PerformanceFunction — `lambda/performance/handler.js` (**partial**)

| Method | Path | Response |
|---|---|---|
| GET | `/performance` | `{ chargedHours, completedHours, rating, trainingPoints }` — hours/rating constants in source |

---

## Training-related

| Method | Path | Lambda | Notes |
|---|---|---|---|
| GET | `/training` | TrainingFunction | Hardcoded videos + progress |
| POST | `/training` | TrainingFunction | `{ videoId, status, points }` |
| POST | `/getUserTrainingList` | UserTrainingList | Array of materials for `SKILL#ALL` + profile skill |
| POST | `/getTrainingVideoUrl` | TrainingVideoUrl | Signed GET |
| POST | `/getTrainingUploadUrl` | trainingUrl | Signed PUT |
| POST | `/addTrainingMaterial` | addTraining | `{ title, skill, level, duration_hours, video_s3_key }` → 201; **no isAdmin check in handler** |
| GET | `/skills` | getSkills | `[{ code, name }]` active skills |
| POST | `/training/mock-test` | MockTestFunction | Static questions; **no getUser** in handler |

---

## ProjectsFunction — `lambda/projects/handler.js` (+ import modules)

| Method | Path | AuthZ | Request | Response |
|---|---|---|---|---|
| GET | `/projects` | JWT | `?status=ACTIVE\|ARCHIVED\|ALL` | Array of projects; 400 invalid status |
| POST | `/projects` | Admin group | `{ name, client, lead, members, status, description }` | 201 item |
| PATCH | `/projects/{projectId}` | Admin group (handler) | body fields | update |
| DELETE | `/projects/{projectId}` | Admin group | — | archive/delete payload |
| GET | `/tasks` | JWT | `projectId, assignee, mine, zone, q/search, priority` | `{ tasks, zoneCounts }` — **unscoped if mine omitted** |
| POST | `/tasks` | Admin group | `projectId`, title, dueDate, assignees, … | 201 decorated |
| PUT | `/tasks` | assignee or Admin | `{ taskId, status, ... }` employee status-only | 200 decorated; 403 Red Zone |
| DELETE | `/tasks` | Admin group | `{ taskId }` or query | `{ message, task }` archived |
| GET | `/tasks/{taskId}` | assignee or Admin | — | detail + `projectName` |
| GET/POST | `/tasks/{taskId}/comments` | access as task | POST `{ text }` | list / 201 |
| GET | `/tasks/{taskId}/activity` | access as task | — | list |
| GET/POST | `/tasks/{taskId}/attachments` | access as task | register after upload | |
| POST | `/tasks/{taskId}/attachment-upload-url` | access as task | `{ fileName, contentType, fileSize }` | `{ uploadUrl, s3Key }` |
| POST | `/tasks/{taskId}/attachment-download-url` | access as task | `{ s3Key or attachmentId }` | `{ downloadUrl }` |
| GET/POST | `/time-entries` | JWT; GET admin may pass email | POST log body | |
| POST | `/task-imports/upload-url` | Admin group | `{ fileName, contentType, fileSize }` | presign + batch id |
| POST | `/task-imports/{batchId}/preview` | Admin group | — | preview |
| POST | `/task-imports/{batchId}/confirm` | Admin group | — | confirm |
| GET | `/task-imports` | Admin group | list query | history |
| GET | `/task-imports/{batchId}` | Admin group | — | detail |
| GET | `/task-imports/{batchId}/download-url` | Admin group | — | signed GET |

No GET `/projects/{id}` in SAM.

---

## LeaveFunction — `lambda/leave/handler.js`

| Method | Path | AuthZ | Query/body | Response |
|---|---|---|---|---|
| GET | `/leave` | JWT | default: own; `all=true` admin; `notifications=true` last 50 NOTIFY | arrays |
| POST | `/leave` | JWT | leave / planned-off fields | 201 |
| PUT | `/leave` | JWT for `readNotification`; Admin group for approve/reject | `{ action, sk }` or `{ leaveId, status, rejectionReason }` | 200 / 409 already decided |

Schedule: auto-approve pending after `LEAVE_APPROVAL_HOURS` (SAM `"5"`).

---

## DocumentsFunction — `lambda/documents/handler.js`

KYC:

| Method | Path | AuthZ |
|---|---|---|
| GET/POST/PUT | `/documents` | JWT; PUT review typically admin |
| POST | `/documents/upload-url` | JWT `{ documentType, fileName, contentType, fileSize }` → `{ uploadUrl, ... }` |
| POST | `/documents/view-url` | JWT |
| GET | `/documents/types` | JWT |
| PUT | `/documents/types` | Admin group |
| GET | `/admin/documents` | Admin group (handler) |

Folder APIs (SAM-wired; S3 manifests):  
`/documents/projects` GET/POST; `/documents/projects/{projectId}` GET/PATCH/DELETE; folders, subfolders, files, download-url (GET/POST/PATCH/DELETE as in `template.yaml`).  
`/documents/personal/{email}` same shape.  
GET `/documents/notifications/feed`, POST `/documents/notifications/mark-seen`.

Per-route body schemas: see `projectsLogic.js` / `personalLogic.js`. Writes for project docs use `canManageProjectDocuments` (Admin/Super Admin, not Manager) **verified in `roles.js` + documents logic**.

---

## AnnouncementsFunction

| Method | Path | AuthZ |
|---|---|---|
| GET | `/announcements` | JWT — visible items |
| GET/POST/PUT/DELETE | `/admin/announcements` | Admin group for writes (GET history also under `/admin/`) |

---

## MeetingsFunction

| Method | Path | AuthZ |
|---|---|---|
| GET | `/meetings` | JWT — participant view |
| GET | `/meetings/{meetingId}` | JWT |
| POST | `/meetings/{meetingId}/join` | JWT |
| GET | `/admin/meetings`, `/admin/meetings/{meetingId}` | Admin group |
| POST/PUT | `/admin/meetings` | Admin group |
| POST | `/admin/meetings/{meetingId}/cancel` | Admin group |

---

## Consent, software, resignation, agent

| Method | Path | Lambda | AuthZ |
|---|---|---|---|
| GET/POST | `/consent` | ConsentFunction | JWT |
| GET | `/software` | SoftwareFunction | JWT |
| GET/POST/PUT/DELETE | `/admin/software` | SoftwareFunction | Admin group |
| POST | `/admin/software/upload-url` | SoftwareFunction | Admin group |
| GET | `/downloads/agent` | AgentDownloadFunction | JWT |
| GET/POST/PUT | `/resignation` | resignation | JWT; PUT review admin in handler |

---

## Not HTTP

NotificationsFunction: EventBridge only.

---

## Incomplete / legacy (verified)

- GET `/work` vs GET `/tasks` dual list APIs
- GET/POST `/training` vs POST `/getUserTrainingList`
- POST `/training/mock-test` unused by `App.jsx`
- GET `/performance` mostly constants
- GET `/admin/getUserProfile` name implies admin; handler does not enforce it
