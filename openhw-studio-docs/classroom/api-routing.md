---
title: Classroom API Routing & Middleware
description: Technical specification of the Express routing layer, authentication pipeline, and multipart upload handling for the OpenHW Studio Classroom System.
outline: deep
---

# Classroom System Routing & Middleware

## Executive Summary
The Classroom System exposes its backend capabilities through a dedicated Express router (`classroomRoutes.js`), mounted at the `/api/classroom` base path. Every route within this domain is strictly gated by a custom JWT authentication middleware, ensuring zero unauthenticated access. 

Additionally, the system utilizes a specialized `multer` configuration to safely process multipart/form-data for assignment and notice attachments.

---

## The Middleware Pipeline

### 1. Authentication Engine (`authMiddleware.js`)
The `protectRoute` middleware is the primary gatekeeper for the entire Classroom API. It operates on a dual-token extraction strategy to support both web clients and potential external API consumers.

**Execution Flow:**
1. **Token Extraction:** Checks for a `Bearer` token in the `Authorization` header. If absent, it falls back to parsing the `jwt` cookie.
2. **Verification:** Validates the signature against `JWT_SECRET`.
3. **Database Hydration:** Fetches the full user object (excluding the password hash) and attaches it to `req.user`.
4. **Dynamic Role Override:** If the decoded JWT contains a specific role (used when an Admin assumes a teacher/student view), the middleware dynamically overrides the database role for the lifecycle of that request.

```javascript
// Dynamic Role Override Implementation
if (decoded.role) {
  user.role = decoded.role;
}
req.user = user;
```

### 2. Multipart Upload Engine (`classroomUpload.js`)
To handle file attachments (PDFs, images) for assignments and notices, the system uses a highly constrained `multer` instance.

**Security & Resource Constraints:**
* **File Size Limit:** Hardcapped at 10MB per file (`10 * 1024 * 1024`).
* **Batch Limit:** Maximum of 10 files per request.
* **MIME Type Whitelist:** Strictly accepts `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/gif`, and `image/svg+xml`. Any other type throws an immediate error before touching the disk.

**Path Sanitization:**
To prevent Directory Traversal attacks, both the filename and the destination directory path are sanitized using a custom regex implementation before writing to the local disk or Docker volume (`CLASSROOM_UPLOADS_DIR`).

```javascript
const sanitizeSegment = (value, fallback) =>
  (value || fallback)
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-") // Strips dangerous path characters
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || fallback;
```

---

## API Surface Area Topology

The Classroom router utilizes RESTful resource nesting to maintain logical hierarchies. All endpoints implicitly require `protectRoute`.

### Classroom & Roster Management
* `POST /api/classroom/` - Creates a new classroom.
* `GET /api/classroom/` - Fetches classrooms relevant to the authenticated user.
* `GET /api/classroom/:classId` - Hydrates a specific classroom dashboard.
* `POST /api/classroom/join` - Enrolls a student via `joinCode`.
* `POST /api/classroom/:classId/invite` - Enrolls students via bulk IDs or emails.
* `GET /api/classroom/:classId/students` - Fetches the student roster.
* `DELETE /api/classroom/:classId/students/:studentId` - Evicts a student.

### Assignment Pipeline
* `POST /api/classroom/:classId/assignments` - Provisions a new assignment.
* `GET /api/classroom/assignments` - Global fetch (supports pagination, search, and date filters).
* `POST /api/classroom/:classId/assignments/:assignmentId/submission` - Upserts a student's project submission.
* `GET /api/classroom/:classId/assignments/:assignmentId/submissions` - Teacher view: Fetches all submissions and completion stats.
* `GET /api/classroom/:classId/assignments/:assignmentId/submission` - Student view: Fetches personal submission state.

### Communication & Assets
* `POST /api/classroom/:classId/notices` - Broadcasts a new notice.
* `POST /api/classroom/:classId/comments` - Polymorphic endpoint for commenting on a specific `postId` (Notice or Assignment).
* `POST /api/classroom/uploads` - Triggers the `classroomUpload` middleware to store files and return sanitized URIs.

### Real-Time & Shared Simulations (Mounted via `api.js`)
While logically part of the classroom, these endpoints are mounted at the root API level to decouple the simulator engine from strict classroom hierarchies.
* `POST /api/live-simulations` - Initializes a WebSocket-ready hardware state.
* `POST /api/simulations/share` - Generates a public/protected hardware template snapshot.