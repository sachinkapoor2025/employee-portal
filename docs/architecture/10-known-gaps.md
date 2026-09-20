# 10 — Known gaps

**Last verified:** 20 September 2026  

Only items supported by repository inspection. Split into verified gaps, risks that need review, and future considerations (not committed work).

---

## Verified gaps

### Stale documentation

| Document | Issue |
|---|---|
| `readme.md` | Describes `backend/src/` and `.github/workflows/backend-deploy.yml` + `frontend-deploy.yml`. Actual layout is `backend/lambda/` and **one** workflow `main.yml`. |
| `PROJECT-OVERVIEW.md` | Mentions Admin Settings, weekly red-zone email, `/tasks/redzone-report`, NotificationsFunction as HTTP APIs. Current `App.jsx` has **no** `/admin/settings`. Current SAM has **no** redzone-report route. NotificationsFunction is **schedule-only**. |

This architecture pack is intended to replace those sections for HLD/LLD.

### Placeholder or partial product surfaces

| Item | Evidence |
|---|---|
| Payroll | `frontend/src/pages/Payroll.jsx` static list, no API |
| Expertise | `Expertise.jsx` static list; does not call GET `/skills` |
| Performance | UI calls GET `/performance`; handler hardcodes `chargedHours`/`completedHours`/`rating` |
| Reports, Admin Management, Audit Logs | `ComingSoon.jsx` routes |
| Mock test API | SAM + `llm/mockTest.js`; **no** route in `App.jsx` |
| Downloads page | `Downloads.jsx` exists; `App.jsx` redirects `/downloads` → `/software-center` |

### Unused or weakly used data

| Item | Evidence |
|---|---|
| `Users` DynamoDB table | Defined in `template.yaml`; no Lambda references to `USERS_TABLE` found |
| `Performance` table | Table exists; performance handler does not query it for the returned hours/rating |
| GET `/work` | Implemented; current My Tasks UI uses GET `/tasks` |

### Duplicate training implementations

1. **GET/POST `/training`** — hardcoded video array + `TrainingProgress` (`training/handler.js`)
2. **POST `/getUserTrainingList`** — DynamoDB `Training_Materials` by skill (`UserTrainingList/app.mjs`) — **used by `Training.jsx`**

These catalogs are not the same data model.

### Missing APIs (relative to product UI or common REST expectations)

- No REST login / refresh / logout (Cognito Hosted UI instead)
- No employee `GET /dashboard` or `GET /me` aggregate
- No `GET /projects/{projectId}` (list + client filter)
- No dedicated `GET /notifications` (leave query flag + documents feed)
- No FCM/APNs
- No self-service forgot-password (admin `resetPassword` only)
- No API version prefix (`/v1`)
- Pagination: **not** on GET `/tasks` or GET `/projects`. **Present** on GET `/admin/attendance-activity`. Notifications GET uses `Limit: 50`.
- Rate limiting / usage plans: **not** in `template.yaml`

### Authorization concerns (source-confirmed)

See `07-authentication-authorization.md`:

- Profile GET-by-email without self/admin check
- Unscoped GET `/tasks` and GET `/projects`
- `addTrainingMaterial` without `isAdmin`
- Temp password in admin API response
- API Gateway data tracing

### Deployment / domain uncertainties

- CloudFront custom domain, ACM, Route53: **not** in `template.yaml` (**unverified**)
- Cognito token TTL: **not** set on the client resource
- SES production identity: **unverified**

### Technical debt

- Dual identity: Cognito groups vs UserAccess roles vs frontend view `role`
- `api.js` maps all 403 to “session expired”
- Implicit OAuth for a SPA (tokens in URL hash)
- `addTraining/app.mjs` hardcodes `region: "ap-south-1"` instead of `AWS_REGION` only
- Leave approver emails hardcoded in SAM env
- Escalation `ORANGE_MS` code default is 2 minutes if env missing; SAM sets 86400000
- Root `readme.md` vs real tree
- Document KYC in DynamoDB vs folder trees in S3 manifests (two storage styles)

---

## Potential risks requiring review

Not confirmed as exploitable in production; they follow directly from code and should be reviewed:

- Any authenticated employee enumerating tasks/projects/profiles if they call APIs outside the SPA conventions
- CloudWatch logs retaining Authorization headers because `DataTraceEnabled` is true
- Admin password reset payload in browser history, proxies, or logs
- ConsentGate writing local acceptance even when POST `/consent` fails (availability over consistency)

Do not treat these as confirmed incidents.

---

## Future architecture considerations

These are **not** implemented. They are implications of the current design for later HLD:

- Second client (mobile): reuse API Gateway + Cognito pool; add PKCE client and callback URLs; do not copy Hosted UI implicit + `localStorage` as-is
- Optional `GET /me` or employee dashboard aggregate to avoid N+1 composition
- Default GET `/tasks` to caller unless admin
- Enforce self-or-admin on profile GET
- Turn off or reduce API data tracing in production
- Reconcile or delete TrainingFunction vs UserTrainingList
- Decide fate of unused `Users` / `Performance` tables
- Pagination before task volume grows
- Keep one SAM stack vs splitting frontend infra — current CI assumes one stack outputs

When implementing a feature, update **04**, **06**, and this file so they stay aligned with `template.yaml`.
