# 03 — Component architecture

**Last verified:** 21 September 2026  
**Sources:** `frontend/src/**`, `backend/lambda/**`, `backend/template.yaml`

## Frontend

### Stack

- React 19, `react-router-dom` 7, CRA (`frontend/package.json`)
- Entry: `frontend/src/index.js` wraps `ThemeProvider` and `App`
- No Redux; UI state is component-local plus `localStorage` / `sessionStorage`
- HTTP: `fetch` wrapper `frontend/src/services/api.js`

### Routing

`frontend/src/App.jsx`:

- Public: `/login`, `/callback`, `/request-access`, `/blocked`
- `HomeRedirect` on `/` (admin view → `/admin/dashboard`, else `Dashboard`)
- `RequireAuth`: requires `token` and `role`; optional `adminOnly` requires view `role === "ADMIN"`
- Authed trees wrap `ConsentGate`
- `ActivityTracker` is a sibling of `Routes` (runs on all pages)

Admin coming-soon routes: `/admin/reports`, `/admin/admin-management`, `/admin/audit-logs` → `ComingSoon.jsx`.  
There is **no** `/admin/settings` route.

**Path ownership:** employee features use non-admin routes (`/`, `/work`, `/work/:taskId`, …). Admin features use `/admin/*`. The URL and the APIs that page calls must stay aligned. Shared pages (for example `TaskDetails.jsx` on `/work/:taskId` and `/admin/tasks/:taskId`) must branch admin-only APIs such as `GET /admin/users`. See [14-employee-admin-path-separation.md](./14-employee-admin-path-separation.md).

### Authentication service

`frontend/src/services/auth.js`:

- Cognito domain and client id from `REACT_APP_*` or hardcoded SPA fallbacks
- `login(intent)`, `handleCallback`, `checkAccess`, `applyAccessRedirect`, `requestAccess`, `logout`
- View helpers: `canAccessAdmin`, `switchPortalView`, `getLoggedInEmail`

### API client

`frontend/src/services/api.js`:

- `api()` — JSON + Bearer; expired JWT or **401** clears session and redirects to `/login`; **403** keeps the session and throws with `status`
- `apiOptional()` — does not clear session on 401/403 (used for some fallbacks)
- Named helpers map 1:1 to backend paths (tasks, leave, documents, meetings, etc.)
- `fetchUsers()` is `GET /admin/users` — admin directory only; employee `/work/:taskId` must not call it

**LLD note:** resource `403` (forbidden) is not the same as unauthenticated. Pages should show access denied and keep the session.

### Layout and shared UI

| Path | Role |
|---|---|
| `components/Layout.jsx` | Sidebar (employee vs admin nav), header, search, notification bell, theme, logout, portal switch |
| `components/ConsentGate.jsx` | Blocks UI until consent accepted (local fallback if API fails) |
| `components/ActivityTracker.jsx` | Starts heartbeat after token exists |
| `components/ui/` | Button, Card, Input, Modal |
| `components/ZoneBadge.jsx`, `ZoneFilter.jsx` | Task zone UI |
| `components/documents/*` | Project and personal document browsers |
| `utils/taskStatus.js` | Client-side zone/status labels |
| `utils/notifications.js` | Bell item classification |
| `constants/roles.js` | Mirrors backend portal roles |

### Communication

```
Page → api.js → API Gateway → Lambda
Layout bell → GET /leave?notifications=true + documents notification feed
ActivityTracker → POST /activity
auth.js → Cognito Hosted UI (full page redirect, not XHR login)
File pickers → POST .../upload-url → browser PUT to S3
```

---

## Backend

### SAM Globals

- Runtime `nodejs18.x`, timeout 10s, memory 256 MB (functions override timeout)
- Shared env: `USERS_TABLE`, `ATTENDANCE_TABLE`, `WORK_TABLE`, `PERFORMANCE_TABLE`, `TRAINING_PROGRESS_TABLE`, `USER_ACCESS_TABLE`, `ACTIVITY_TABLE`

### Lambda modules (SAM logical IDs)

| Logical ID | Handler file | Owns |
|---|---|---|
| PreSignUpFunction | `lambda/cognito/preSignUp.js` | Cognito pre-signup domain check |
| AttendanceFunction | `lambda/attendance/handler.js` | Attendance HTTP |
| TrainingFunction | `lambda/training/handler.js` | Hardcoded video catalog + progress |
| WorkFunction | `lambda/work/handler.js` | Legacy GET `/work` |
| PerformanceFunction | `lambda/performance/handler.js` | GET `/performance` |
| AdminFunction | `lambda/admin/handler.js` | GET/POST `/admin/users` |
| AccessFunction | `lambda/access/handler.js` | `/access`, `/request-access` |
| MockTestFunction | `lambda/llm/mockTest.js` | Static quiz JSON |
| ImageUploadFunction | `lambda/ImageUpload/app.mjs` | Profile image presign |
| UserProfileFunction | `lambda/UserProfileFunction/app.js` | POST `/admin/save-user-profile` (create/edit user+profile) |
| UserProfile | `lambda/UserProfile/app.mjs` | GET profile |
| TrainingVideoUrl | `lambda/TrainingVideoUrl/app.mjs` | Signed video GET |
| trainingUrl | `lambda/trainingUrl/app.mjs` | Training upload presign |
| UserTrainingList | `lambda/UserTrainingList/app.mjs` | Materials by skill |
| getSkills | `lambda/getSkills/app.mjs` | Skill master |
| resignation | `lambda/resignation/app.mjs` | Exit requests |
| addTraining | `lambda/addTraining/app.mjs` | Insert training material |
| ActivityFunction | `lambda/activity/handler.js` | Activity + admin dashboard |
| ProjectsFunction | `lambda/projects/handler.js` | Projects, tasks, import, time, escalation |
| LeaveFunction | `lambda/leave/handler.js` | Leave + in-app notify read + auto-approve |
| NotificationsFunction | `lambda/notifications/handler.js` | Scheduled emails only |
| DocumentsFunction | `lambda/documents/handler.js` | KYC docs + S3 folder browsers |
| AnnouncementsFunction | `lambda/announcements/handler.js` | Announcements |
| MeetingsFunction | `lambda/meetings/handler.js` | Meetings |
| ConsentFunction | `lambda/consent/handler.js` | Consent |
| AgentDownloadFunction | `lambda/agentDownload/handler.js` | Tracker download URL |
| SoftwareFunction | `lambda/software/handler.js` | Software catalog |

### Shared backend modules (`backend/lambda/common/`)

| File | Role |
|---|---|
| `auth.js` | `getUser`, `@mydgv.com`, `isAdmin` from groups |
| `roles.js` | Portal roles, Cognito group mapping, admin email list from UserAccess |
| `response.js` | JSON + CORS headers |
| `notify.js` | In-app `NOTIFY#` items + SES channel selection |
| `email.js` | SES send helper |
| `geo.js` | IP → location for activity |
| `requestMeta.js` | IP/device from API Gateway event |
| `documentsStorage.js` | S3 JSON manifests for project/personal folders |

### ProjectsFunction supporting files

`escalation.js`, `projectManage.js`, `taskImport.js`, `taskImportParse.js`, `taskImportPreview.js`, `taskImportConfirm.js`, `taskImportHistory.js`, `taskImportAudit.js`, `zoneNotify.js`, `redAdminNotify.js`.

### Feature ownership (who talks to whom)

- **Identity:** Access + Admin + UserProfileFunction + Cognito Admin APIs
- **Work management:** ProjectsFunction (HTTP + schedule) is the hub for projects/tasks/zones/imports
- **People operations:** Attendance, Leave, Activity, Documents, Resignations
- **Comms:** Announcements, Meetings, `common/notify.js`, NotificationsFunction (email batch)
- **Learning:** UserTrainingList + SkillMaster + addTraining; **separate** TrainingFunction catalog
- **Software:** SoftwareFunction + AgentDownloadsBucket

Lambdas do not call each other over HTTP. They share DynamoDB/S3 and `require()` sibling modules (e.g. Leave `require`s meetings compat; activity `require`s `countActiveProjects`).
