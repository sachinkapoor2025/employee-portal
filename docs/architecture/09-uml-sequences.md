# 09 — UML and sequence diagrams

**Last verified:** 20 September 2026  

Diagrams follow **implemented** code. They omit UI-only placeholders.

---

## 1. System context

```mermaid
flowchart LR
  Emp[Employee]
  Adm[Admin / Manager / Super Admin]
  Portal[DGV Employee Portal]
  Cog[Amazon Cognito]
  Ses[Amazon SES]
  Emp --> Portal
  Adm --> Portal
  Portal --> Cog
  Portal --> Ses
```

---

## 2. Container architecture

```mermaid
flowchart LR
  B[Browser SPA]
  CF[CloudFront + S3]
  C[Cognito Hosted UI]
  G[API Gateway /prod]
  L[Lambdas]
  E[EventBridge]
  D[(DynamoDB)]
  S[S3 data]
  M[SES]
  B --> CF
  B --> C
  C --> B
  B --> G
  G --> L
  E --> L
  L --> D
  L --> S
  L --> M
```

---

## 3. Login and authentication

```mermaid
sequenceDiagram
  actor U as User
  participant Login as Login.jsx
  participant Auth as auth.js
  participant Cog as Cognito Hosted UI
  U->>Login: Sign in as Employee or Admin
  Login->>Auth: login(intent)
  Auth->>Auth: sessionStorage.portalIntent
  Auth->>Cog: GET /login?response_type=token
  Cog->>Auth: redirect /callback#id_token
```

Callback continuation is diagram 4.

---

## 4. Access verification

```mermaid
sequenceDiagram
  participant CB as Callback.jsx
  participant Auth as auth.js
  participant API as API Gateway
  participant Acc as AccessFunction
  participant D as UserAccess
  CB->>Auth: handleCallback
  Auth->>Auth: localStorage.token = id_token
  Auth->>API: GET /access Bearer JWT
  API->>Acc: claims.email groups
  Acc->>D: GetItem PK=email SK=email
  alt no item
    Acc->>D: PutItem ACTIVE role from groups
  end
  Acc-->>Auth: access + role
  Auth->>Auth: applyAccessRedirect
```

---

## 5. Task creation

Admin group required (`POST /tasks`).

```mermaid
sequenceDiagram
  participant UI as ManageTasks / AddTask
  participant API as api.js
  participant P as ProjectsFunction
  participant D as WorkTasks
  UI->>API: POST /tasks {projectId,title,dueDate,assignees,...}
  API->>P: JWT
  P->>P: user.isAdmin?
  alt not admin
    P-->>UI: 403 Admin required
  else admin
    P->>P: validateCreatePayload
    P->>D: Put ENTITY#TASK + PROJECT# copy + ASSIGNMENT# rows
    P-->>UI: 201 decorateTask
  end
```

---

## 6. Task status update

```mermaid
sequenceDiagram
  participant UI as Work / TaskDetails
  participant P as ProjectsFunction
  participant D as WorkTasks
  UI->>P: PUT /tasks {taskId,status}
  P->>D: Get ENTITY#TASK
  alt not found
    P-->>UI: 404
  else not assignee and not admin
    P-->>UI: 403 Forbidden
  else employee and zone RED
    P-->>UI: 403 Red Zone admin only
  else allowed
    P->>D: persist assignment + task copies
    P-->>UI: 200 decorateTask
  end
```

---

## 7. Task escalation

```mermaid
sequenceDiagram
  participant EB as EventBridge 5 min
  participant P as ProjectsFunction
  participant D as WorkTasks
  participant N as notify.js / SES
  EB->>P: {taskEscalation:true}
  P->>D: query tasks and assignments
  P->>P: zoneAt(dueDate, now) vs recordedZone
  P->>D: persist recordedZone / highestZone
  opt new Orange
    P->>N: in-app TASK_ORANGE for assignee
  end
  opt new Red
    P->>N: in-app TASK_RED; admin email path redAdminNotify.js
  end
```

---

## 8. Leave approval

```mermaid
sequenceDiagram
  participant Emp as Leave.jsx
  participant LF as LeaveFunction
  participant D as WorkTasks
  participant Adm as LeaveManagement.jsx
  Emp->>LF: POST /leave
  LF->>D: ENTITY#LEAVE + USER# copy
  LF->>LF: notifyApprovers
  Note over LF,D: EventBridge autoApprove may APPROVE after LEAVE_APPROVAL_HOURS
  Adm->>LF: PUT /leave {leaveId,status}
  LF->>LF: user.isAdmin?
  alt not pending
    LF-->>Adm: 409
  else APPROVED or REJECTED
    LF->>D: update leave copies
    LF-->>Adm: 200
  end
```

---

## 9. Document upload (presigned URL)

KYC path (`documents/handler.js`). Folder browsers use a similar upload-url then S3 PUT pattern.

```mermaid
sequenceDiagram
  participant UI as Documents.jsx
  participant Doc as DocumentsFunction
  participant S3 as DocumentsBucket
  UI->>Doc: POST /documents/upload-url {documentType,fileName,contentType,fileSize}
  Doc->>Doc: validate type and extension
  Doc-->>UI: uploadUrl + keys
  UI->>S3: HTTP PUT file
  UI->>Doc: POST /documents register metadata
  Doc->>Doc: Put ENTITY#DOCUMENT + USER CURRENT#type
  Doc-->>UI: 200/201 item
```

---

## 10. Excel task import

```mermaid
sequenceDiagram
  participant UI as TaskImportModal
  participant P as ProjectsFunction
  participant S3 as DocumentsBucket task-imports/tmp
  participant D as WorkTasks IMPORT#
  UI->>P: POST /task-imports/upload-url
  P->>P: user.isAdmin
  P-->>UI: uploadUrl batchId
  UI->>S3: PUT xlsx
  UI->>P: POST /task-imports/{batchId}/preview
  P->>S3: read object
  P->>D: validation rows META
  P-->>UI: preview
  UI->>P: POST /task-imports/{batchId}/confirm
  P->>D: create tasks / scheduled assigns
  P-->>UI: COMPLETED or PARTIAL
```

---

## 11. Deployment flow

```mermaid
sequenceDiagram
  participant Dev as Git push
  participant GHA as GitHub Actions
  participant SAM as sam deploy
  participant AWS as Stack mydgv-portal
  participant FE as npm run build
  participant S3 as Frontend bucket
  participant CF as CloudFront
  Dev->>GHA: main / dev / feature/*
  GHA->>SAM: backend sam build deploy
  SAM->>AWS: Lambdas API Cognito DDB S3
  AWS-->>GHA: ApiUrl Cognito ids bucket dist id
  GHA->>FE: write frontend/.env
  FE->>S3: sync build --delete
  GHA->>CF: create-invalidation
```

GitHub uses IAM user keys from Actions secrets (`configure-aws-credentials`).
