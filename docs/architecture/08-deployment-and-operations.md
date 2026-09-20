# 08 — Deployment and operations

**Last verified:** 20 September 2026  
**Sources:** `backend/template.yaml`, `backend/samconfig.toml`, `.github/workflows/main.yml`, `frontend/src/services/auth.js`

## AWS region

**Verified:** `ap-south-1` (`samconfig.toml` `region`, GitHub Actions `aws-region`).

## SAM / CloudFormation

| | |
|---|---|
| Template | `backend/template.yaml` |
| Transform | `AWS::Serverless-2016-10-31` |
| Stack name | `mydgv-portal` |
| S3 prefix | `mydgv-portal` |
| Capabilities | `CAPABILITY_IAM CAPABILITY_NAMED_IAM` |
| Parameter | `FrontendDomainName` default `login.mydgv.com` |
| Parameter | `NotificationFromEmail` default `noreply@mydgv.com` |
| Parameters | task import retention days (hold/tmp) |

Local SAM deploy uses the same stack name (`confirm_changeset = false`).

## GitHub Actions

File: `.github/workflows/main.yml`  
Triggers: push to `main`, `dev`, `feature/*`

**Job `deploy-backend`:**

1. Checkout
2. `aws-actions/setup-sam`
3. `configure-aws-credentials` with GitHub secrets
4. `sam build` / `sam deploy` in `backend/` with `--parameter-overrides FrontendDomainName=login.mydgv.com`
5. `aws cloudformation describe-stacks --stack-name mydgv-portal` → outputs

**Job `deploy-frontend`:**

1. Write `frontend/.env`: `REACT_APP_API_URL`, `REACT_APP_COGNITO_CLIENT_ID`, `REACT_APP_COGNITO_DOMAIN`
2. Node 24, `npm install`, `npm run build`
3. `s3-sync-action` `--delete` from `frontend/build` to stack frontend bucket
4. CloudFront invalidation using `FrontendCloudFrontDistributionId`

## Secrets handling

**Verified in workflow (names only):** `secrets.AWS_ACCESS_KEY_ID`, `secrets.AWS_SECRET_ACCESS_KEY`.

No AWS keys in application source (search during audit). Cognito **client id** is a public SPA identifier; a fallback is hardcoded in `auth.js`.

## Lambda runtime and defaults

SAM `Globals.Function`:

- Runtime: `nodejs18.x`
- Timeout: 10s
- Memory: 256 MB

Overrides (verified): ProjectsFunction 120s; Leave/Attendance 30s; UserProfileFunction 30s; DocumentsFunction 29s; NotificationsFunction 60s; Announcements/Meetings 20s.

## EventBridge schedules

| Name suffix | Schedule | Target | Enabled |
|---|---|---|---|
| `task-escalation` | `rate(5 minutes)` | ProjectsFunction | true |
| `leave-auto-approve` | `rate(5 minutes)` | LeaveFunction | true |
| `announcement-expiry` | `rate(5 minutes)` | AnnouncementsFunction | true |
| `meeting-reminders` | `rate(5 minutes)` | MeetingsFunction | true |
| `daily-notifications` | `cron(30 3 * * ? *)` | NotificationsFunction | true |

## SES

- Parameter `NotificationFromEmail`
- Env `NOTIFICATION_FROM_EMAIL`, `NOTIFICATION_FROM_NAME` (`DGV Portal`), `PORTAL_URL` = `https://${FrontendDomainName}`
- IAM `ses:SendEmail`, `ses:SendRawEmail` on Projects, Notifications, Documents (and send path via `common/email.js`)
- Identity verification / sandbox status: **unverified** in repo

## CloudWatch

- API Gateway log group `/aws/apigateway/${stack}-prod`, retention 14 days
- Method settings: LoggingLevel INFO, **DataTraceEnabled: true**, MetricsEnabled: true
- Lambda basic execution role (standard `/aws/lambda/...` groups — created by AWS, not all named in template)

## Environment variables (representative)

**Globals:** `USERS_TABLE`, `ATTENDANCE_TABLE`, `WORK_TABLE`, `PERFORMANCE_TABLE`, `TRAINING_PROGRESS_TABLE`, `USER_ACCESS_TABLE`, `ACTIVITY_TABLE`

**ProjectsFunction:** `TASK_ORANGE_MS=86400000`, `COMPANY_TIMEZONE=Asia/Kolkata`, `COMPANY_TZ_OFFSET=+05:30`, import limits, SES/portal URL, bucket names

**LeaveFunction:** `LEAVE_APPROVAL_HOURS=5`, `LEAVE_APPROVER_EMAILS` (emails in template — operational config, not secret keys)

**DocumentsFunction:** `DOCUMENT_MAX_BYTES`, `DOCUMENT_URL_TTL_SECONDS=300`

Frontend runtime: `REACT_APP_API_URL`, `REACT_APP_COGNITO_CLIENT_ID`, `REACT_APP_COGNITO_DOMAIN` (CI-generated; SPA has hardcoded fallbacks).

## Production vs local

| | Production | Local |
|---|---|---|
| SPA | CloudFront → S3 | `cd frontend && npm start` → :3000 |
| API | execute-api `/prod` | same deployed API unless a local SAM proxy is used (**no local API recipe in this pack**) |
| Cognito callbacks | `https://login.mydgv.com/callback` | `http://localhost:3000/callback` (in User Pool client) |

Backend unit tests: `backend/package.json` `npm test` (Node scripts, not SAM invoke).

## Custom domain / TLS — unverified

`template.yaml` CloudFront distribution:

- `ViewerProtocolPolicy: redirect-to-https`
- No `Aliases`
- No ACM `ViewerCertificate` block

Whether `login.mydgv.com` points at this distribution is **unverified** (may be configured outside the template). Output `FrontendCloudFrontDomain` is the `*.cloudfront.net` name.

## Frontend infra

- Private S3 bucket + OAC
- CloudFront SPA fallback: 403/404 → `/index.html` with 200
