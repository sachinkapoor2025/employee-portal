# DGV Employee Portal — Architecture Documentation

**Last verified:** 21 September 2026  
**Scope:** Documentation only. This folder does not change application or AWS behavior.

## Purpose

This package is the source-accurate architecture record for:

- High-Level Design (HLD)
- Low-Level Design (LLD)
- UML / sequence diagrams
- Feature implementation planning

It describes the **current** monorepo, not a proposed future system.

## Repository and system overview

The DGV Employee Portal is a **single repository** with:

| Area | Location | Role |
|---|---|---|
| React SPA | `frontend/` | Employee and admin UI (Create React App) |
| Serverless backend | `backend/` | AWS SAM, API Gateway, Lambdas, DynamoDB, S3, Cognito, EventBridge, SES |
| CI/CD | `.github/workflows/main.yml` | SAM deploy + frontend S3/CloudFront publish |
| Stack | `mydgv-portal` | `backend/samconfig.toml` |
| Region | `ap-south-1` | SAM config and GitHub Actions |

The live SPA is intended at `https://login.mydgv.com` (SAM parameter `FrontendDomainName`). The SPA default API fallback is `https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod` (`frontend/src/services/api.js`).

**Style:** Serverless modular monolith — one Cognito user pool, one REST API (`prod` stage), many Lambdas, DynamoDB as the system of record, S3 for blobs, EventBridge for clocks, SES for email.

## Documentation index

| File | Contents |
|---|---|
| [01-context-and-actors.md](./01-context-and-actors.md) | Actors, access outcomes, system boundary |
| [02-system-hld.md](./02-system-hld.md) | Containers, request and background flows |
| [03-component-architecture.md](./03-component-architecture.md) | Frontend and Lambda modules |
| [04-feature-code-map.md](./04-feature-code-map.md) | Feature → route → API → handler → data |
| [05-data-architecture.md](./05-data-architecture.md) | DynamoDB tables and WorkTasks key patterns |
| [06-api-catalog.md](./06-api-catalog.md) | HTTP routes from SAM, verified against handlers |
| [07-authentication-authorization.md](./07-authentication-authorization.md) | Cognito, JWT, roles, guards, verified risks |
| [08-deployment-and-operations.md](./08-deployment-and-operations.md) | SAM, GitHub Actions, schedules, env, secrets |
| [09-uml-sequences.md](./09-uml-sequences.md) | Mermaid diagrams of implemented flows |
| [10-known-gaps.md](./10-known-gaps.md) | Stale docs, placeholders, debt |
| [11-project-level-access-control-audit.md](./11-project-level-access-control-audit.md) | Phase 1 read-only audit: project membership / ACL (not implemented) |
| [12-project-acl-requirements.md](./12-project-acl-requirements.md) | Phase 2 requirements, actors, acceptance, open decisions (not implemented) |
| [13-project-acl-technical-design.md](./13-project-acl-technical-design.md) | Phase 2 data/API/task/migration/UI/impact/stages (not implemented) |
| [14-employee-admin-path-separation.md](./14-employee-admin-path-separation.md) | Employee vs admin SPA paths and which APIs each path may call |

Related but **not** architecture source of truth:

- `PROJECT-OVERVIEW.md` — useful map; some sections are stale vs `template.yaml` / `App.jsx`
- `readme.md` — describes `backend/src/` and two deploy workflows that **do not exist**
- `docs/FEATURE-EMPLOYEE-SEARCH.md` — feature note for admin user search
- `docs/dgv-*-demo.html` — UI demos, not runtime architecture

## Source-of-truth rules

1. **Highest:** `backend/template.yaml`, Lambda handlers under `backend/lambda/`, frontend under `frontend/src/`.
2. **Next:** `backend/samconfig.toml`, `.github/workflows/main.yml`.
3. **Lowest:** narrative markdown (`PROJECT-OVERVIEW.md`, root `readme.md`). If they conflict with (1), follow (1).

Do not invent AWS resources, APIs, tables, or security controls that are not in source.

### How claims are labeled

| Label | Meaning |
|---|---|
| **Verified** | Observed in `template.yaml` or application source |
| **Assumption** | Reasonable inference, not proven in repo |
| **Unverified** | Cannot be confirmed from this repository (e.g. DNS/ACM outside SAM) |

## How to use these documents before implementing a feature

1. Read **01** and **02** for system context.
2. Find the feature in **04**. If it is not listed as implemented, do not assume an API exists.
3. Open the listed handler and SAM events; confirm Path/Method still match **06**.
4. Check keys and tables in **05** before adding DynamoDB items.
5. Check **07** for JWT vs Cognito group vs UserAccess vs resource checks.
6. Check **14** before adding or sharing employee/admin pages: the SPA path must not call APIs the other role is forbidden to use.
7. If the change is scheduled, email, or file upload, read **08** and the matching sequence in **09**.
8. Record new gaps in **10** rather than silently updating overview markdown.

## Unverified at pack level

- Whether CloudFront is actually aliased to `login.mydgv.com` (no ACM/aliases in `template.yaml`).
- Live Cognito token TTL values (not set in the SAM client resource).
- Production SES verification / bounce configuration (only IAM `ses:SendEmail` and sender parameter exist).
- Contents of deployed DynamoDB (schema is inferred from writers, not a dump).
