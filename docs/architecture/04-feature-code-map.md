# 04 — Feature → code map

**Last verified:** 21 September 2026  

**Status values**

- **Implemented** — SPA route exists and calls a SAM-wired API (or Cognito) whose handler performs the feature
- **Partial** — UI or API exists but behavior is hardcoded, incomplete, or unused by the intended page
- **Placeholder** — route/UI with no real backend
- **Not implemented** — mentioned in stale docs or missing

Authorization column: **Gateway** = Cognito JWT required (SAM default). Extra checks are handler-level (`user.isAdmin` = Cognito group `Admin` unless noted).

| Feature | Frontend route / page | API | Lambda | Supporting files | Data | AuthZ | Status |
|---|---|---|---|---|---|---|---|
| Hosted UI login | `/login` `Login.jsx` | Cognito `/login` (not REST) | — | `services/auth.js` | User pool | Cognito | Implemented |
| OAuth callback | `/callback` | — | — | `auth.js` `handleCallback` | `localStorage` token | — | Implemented |
| Logout | Layout | Cognito `/logout` | — | `auth.js` | — | — | Implemented |
| Access check | after callback | GET `/access` | AccessFunction | `access/handler.js` | UserAccess | JWT + domain | Implemented |
| Request access | `/request-access` | POST `/request-access` | AccessFunction | same | UserAccess | JWT | Implemented |
| Blocked | `/blocked` | — | — | redirect from access | — | — | Implemented |
| Consent | all authed | GET/POST `/consent` | ConsentFunction | `consent/handler.js`, `ConsentGate.jsx` | WorkTasks `ENTITY#CONSENT` | JWT | Implemented |
| Employee dashboard | `/` `Dashboard.jsx` | GET `/tasks?mine=true`, `/leave`, `/announcements` | Projects, Leave, Announcements | composed in UI | WorkTasks | JWT | Implemented (no `/dashboard` API) |
| Admin dashboard | `/admin/dashboard` | GET `/admin/dashboard` | ActivityFunction | `activity/handler.js` | ActivityLog, WorkTasks | JWT + `isAdmin` | Implemented |
| Attendance employee | `/attendance` | GET/POST `/attendance` | AttendanceFunction | `attendance/handler.js` | Attendance | JWT | Implemented |
| Attendance admin | `/admin/attendance-activity` | GET `/admin/attendance-activity` | AttendanceFunction | same | Attendance | JWT + `isAdmin` | Implemented |
| My tasks | `/work`, `/work/:taskId` | GET `/tasks?mine=true`, GET `/tasks/{id}`, PUT `/tasks` (assignee fields). **Not** `GET /admin/users` | ProjectsFunction | `Work.jsx`, `TaskDetails.jsx` (`employeeView`), `escalation.js` | WorkTasks | JWT; detail/update assignee or admin | Implemented |
| Legacy work list | not used by current Work page (Work uses `/tasks`) | GET `/work` | WorkFunction | `work/handler.js` | WorkTasks | JWT | Implemented API; **legacy** vs decorated `/tasks` |
| Admin tasks | `/admin/tasks`, `/admin/tasks/:taskId` | `/tasks*` POST/PUT/DELETE, comments, attachments; detail page may `GET /admin/users` for reassign | ProjectsFunction, AdminFunction | `ManageTasks.jsx`, `TaskDetails.jsx` (admin path) | WorkTasks + profile S3 attachments | JWT; OPEN admin create/archive/list via ACTIVE UserAccess ADMIN/SUPER_ADMIN (not Cognito `isAdmin`); RESTRICTED via Project Admin; user directory still `isAdmin` | Implemented |
| Projects | `/admin/projects` | GET/POST `/projects`, PATCH/DELETE `/projects/{id}` | ProjectsFunction | `projectManage.js` | WorkTasks + UserAccess | GET: JWT + catalog ACL; POST/PATCH/DELETE: ACTIVE UserAccess ADMIN/SUPER_ADMIN (not Cognito `isAdmin`, not Project Admin) | Implemented (no GET-by-id) |
| Task import | `/admin/task-imports*` | `/task-imports*` | ProjectsFunction | `taskImport*.js` | WorkTasks + DocumentsBucket | JWT + ACTIVE UserAccess ADMIN/SUPER_ADMIN; project-scoped create/view (RESTRICTED needs Project Admin) | Implemented |
| Task zones / Red email | task UI | GET decorate + EventBridge | ProjectsFunction | `escalation.js`, `redAdminNotify.js`, `zoneNotify.js` | assignments, NOTIFY, SES | sweep unauthenticated (schedule) | Implemented |
| Time entries | task UI | GET/POST `/time-entries` | ProjectsFunction | `handler.js` | WorkTasks | JWT; GET `?email=` ACTIVE UserAccess ADMIN/SUPER_ADMIN; task READ filter | Implemented |
| Leave | `/leave` | GET/POST `/leave` | LeaveFunction | `leave/handler.js` | WorkTasks, Attendance | JWT | Implemented |
| Leave admin | `/admin/leave` | GET `/leave?all=true`, PUT review | LeaveFunction | `LeaveManagement.jsx` | WorkTasks | `isAdmin` for all/review | Implemented |
| Leave auto-approve | — | schedule | LeaveFunction | env `LEAVE_APPROVAL_HOURS` | WorkTasks | schedule | Implemented |
| In-app bell | `Layout.jsx` | GET `/leave?notifications=true`, PUT `{action:readNotification}` | LeaveFunction | `notify.js`, `utils/notifications.js` | `NOTIFY#` | JWT (own PK) | Implemented |
| Document KYC | `/documents` | `/documents*`, types, upload-url, view-url | DocumentsFunction | `documents/handler.js` | WorkTasks + DocumentsBucket | JWT; types PUT / admin list: `isAdmin` | Implemented |
| Document folders | Documents browsers | `/documents/projects*`, `/documents/personal*` | DocumentsFunction | `projectsLogic.js`, `personalLogic.js`, `documentsStorage.js` | **S3 manifests**, not DDB | JWT; writes use role helpers | Implemented |
| Document notify feed | Layout | GET `/documents/notifications/feed`, POST mark-seen | DocumentsFunction | `notificationsLogic.js` | S3 notification events | JWT | Implemented |
| Announcements | dashboard + `/admin/announcements` | GET `/announcements`, `/admin/announcements` CRUD | AnnouncementsFunction | `announcements/logic.js` | WorkTasks | admin writes: `isAdmin` | Implemented |
| Meetings | `/meetings`, `/admin/meetings` | `/meetings*`, `/admin/meetings*` | MeetingsFunction | `meetings/logic.js` | WorkTasks | admin mutate: `isAdmin` | Implemented |
| Meeting reminders | — | schedule | MeetingsFunction | SAM | WorkTasks, SES via notify | schedule | Implemented |
| Training materials UI | `/training` | POST `/getUserTrainingList`, POST `/getTrainingVideoUrl` | UserTrainingList, TrainingVideoUrl | `Training.jsx` | Training_Materials, UserProfile, training S3 | JWT | Implemented |
| Hardcoded training catalog | **not** used by `Training.jsx` | GET/POST `/training` | TrainingFunction | `training/handler.js` | TrainingProgress | JWT | Implemented API; **parallel/legacy** |
| Add training | `/admin/add-training` | POST `/addTrainingMaterial`, `/getTrainingUploadUrl`, GET `/skills` | addTraining, trainingUrl, getSkills | `AddTraining.jsx` | Training_Materials, SkillMaster, S3 | JWT; **no `isAdmin` in addTraining handler** | Implemented (admin UI only) |
| Skills catalog | admin profile / add training | GET `/skills` | getSkills | `getSkills/app.mjs` | SkillMaster | JWT; handler ignores user | Implemented |
| Expertise page | `/expertise` | none | — | static list | — | view auth | Placeholder |
| Profile | `/profile` | GET `/admin/getUserProfile?email=`, POST save, image URL | UserProfile, UserProfileFunction, ImageUpload | `Profile.jsx` | UserProfile, profile S3 | JWT; save EDIT self or admin | Implemented |
| Admin employees | `/admin/employees*` | GET/POST `/admin/users`, save-user-profile | AdminFunction, UserProfileFunction | `ManageUsers.jsx`, `AdminEmployeeProfile.jsx` | UserAccess, UserProfile, Cognito | JWT + `isAdmin` on `/admin/users` | Implemented |
| Activity tracking | all pages | POST `/activity`, GET `/activity/today` | ActivityFunction | `activityTracker.js` | ActivityLog | JWT | Implemented |
| Team activity | `/admin/activity` | GET `/admin/activity` | ActivityFunction | `TeamActivity.jsx` | ActivityLog | JWT + `isAdmin` | Implemented |
| Performance | `/performance` | GET `/performance` | PerformanceFunction | `performance/handler.js` | TrainingProgress + **hardcoded hours/rating** | JWT | Partial |
| Payroll | `/payroll` | none | — | static | — | view auth | Placeholder |
| Software center | `/software-center` | GET `/software`, `/admin/software*` | SoftwareFunction | `software/handler.js` | WorkTasks `ENTITY#SOFTWARE`, AgentDownloadsBucket | admin CRUD: `isAdmin` | Implemented |
| Agent download API | `Downloads.jsx` unused by route | GET `/downloads/agent` | AgentDownloadFunction | — | AgentDownloadsBucket | JWT | Implemented API; `/downloads` **redirects** to software-center |
| Exit / resignation | `/exit`, `/admin/resignations` | GET/POST/PUT `/resignation` | resignation | `resignation/app.mjs` | Resignations | JWT; review typically admin in handler | Implemented |
| Mock test | none in App routes | POST `/training/mock-test` | MockTestFunction | `llm/mockTest.js` | none | Gateway JWT; handler ignores user | Partial / unused UI |
| Reports / audit / admin-mgmt | `/admin/reports` etc. | none | — | `ComingSoon.jsx` | — | admin view | Placeholder |
| Settings / weekly red-zone digest | none | none in current SAM | — | stale `PROJECT-OVERVIEW.md` | — | — | Not implemented |

Employee search on Manage Users is **client-side filter** (`docs/FEATURE-EMPLOYEE-SEARCH.md`); no extra API.

Employee vs admin SPA path ownership (especially `/work/:taskId` vs `/admin/tasks/:taskId`) is documented in [14-employee-admin-path-separation.md](./14-employee-admin-path-separation.md).
