---
title: Classroom API & Core Workflows
description: Engineering documentation detailing the API controllers, access control mechanisms, and submission lifecycles of the OpenHW Studio Classroom System.
outline: deep
---

# Classroom System API & Workflows

## Executive Summary
The Classroom System's backend logic is distributed across three primary controllers: `classroomController.js`, `liveSimulationController.js`, and `sharedSimulationController.js`. 

This API layer is strictly role-gated, relying on an intersection of JWT role claims (`student`, `teacher`, `admin`) and relational database verification (checking `User._id` against `Class.students` or `Class.teacher` arrays). This document maps the core workflows, data sanitization patterns, and execution pipelines.

---

## Authorization & Access Control

All endpoint execution is front-loaded with a rigid authorization matrix. The system employs a "Defense in Depth" strategy, validating the JWT first, followed by resource-level ownership checks.

### The Access Verification Engine
Before any significant CRUD operation (e.g., viewing a class, commenting, submitting), the controller invokes the `userCanAccessClass` utility:

```javascript
const userCanAccessClass = (classroom, user) => {
  const userId = extractId(user?._id || user?.id);
  if (!userId || !classroom) return false;

  const isOwner = extractId(classroom.teacher) === userId;
  const isStudent = Array.isArray(classroom.students) &&
    classroom.students.some((studentValue) => extractId(studentValue) === userId);

  return isOwner || isStudent;
};
```
* **Architecture Note:** The `extractId` helper normalizes incoming data, ensuring robust matching regardless of whether Mongoose passes raw ObjectIds, populated Objects, or stringified IDs.
* **Admin Overrides:** Many endpoints include an explicit `req.user.role === "admin"` bypass to allow system administrators to moderate classrooms without being explicitly enrolled in the `students` or `teacher` arrays.

---

## Core Operational Workflows

### 1. Classroom Provisioning & Roster Sync
Classroom creation is restricted to `teacher` and `admin` roles. 

**Collision-Resistant Join Codes:**
Instead of relying solely on MongoDB's unique index to catch errors, `createUniqueJoinCode()` implements a proactive while-loop that attempts to generate a random 36-radix string up to 5 times. If a collision occurs, it regenerates before hitting the database constraint.

**Roster Synchronization:**
When students join via `joinClassroomByCode` or are added via `inviteStudents`, a dual-write process occurs:
1. The `Class.students` array receives the `User._id` (`$addToSet`).
2. The `User.classes` array receives the `Class._id` (`$addToSet`).
This ensures bidirectional referential integrity without triggering race conditions.

### 2. Assignment & Template Distribution
Assignments are the core evaluative unit. When a teacher creates an assignment, they can attach a `templateProjectId` or a `templateUrl`.

**URL Extraction Logic:**
The `createAssignment` and `updateAssignment` pipelines automatically parse `templateShareId` values directly from provided URLs using regex. This reduces frontend complexity by allowing teachers to paste raw simulator URLs, while the backend extracts the exact hex identifier needed for rendering.

### 3. The Submission Engine (Upsert Mechanics)
The `upsertAssignmentSubmission` endpoint handles the intake of student hardware projects. 

**Deadline Enforcement:**
The API strictly enforces deadlines at the server level, preventing client-side bypasses:
```javascript
if (assignment.dueDate && new Date(assignment.dueDate) < new Date()) {
  return res.status(400).json({
    message: "This assignment is closed. Submissions are no longer accepted.",
  });
}
```

**Upsert State Management:**
Rather than managing separate `POST` (create) and `PATCH` (update) routes for submissions, the API utilizes `findOneAndUpdate` with `upsert: true`. This ensures that a student only ever has one unified submission state per assignment, effectively eliminating duplicate document creation during rapid network retries.

### 4. Real-Time Initialization (`LiveSimulation`)
The `liveSimulationController.js` provisions the initial state for WebSocket-driven sessions.

When a teacher triggers `createLiveSimulation`, the API extracts the `snapshot` payload (`board`, `components`, `connections`, `code`). This payload is normalized and stored directly in the `LiveSimulationSession` document. This allows joining students to immediately download the current circuit state via REST before the WebSocket handshake occurs, ensuring a stable initial render.

### 5. Shared Simulation Guardrails
The `sharedSimulationController.js` governs how simulator states are exposed. 
* **Teachers/Admins:** Can share any project globally as a public template.
* **Students:** Are heavily restricted. A student can *only* share a simulation if it is actively tied to a valid `classId` and `assignmentId` that has not surpassed its `dueDate`. This prevents students from using the platform as a public code-sharing repository.

---

## Technical Debt & Audit Notes

**1. Pagination Memory Overhead**
Endpoints like `getAssignments` and `getClassroomNotices` implement skip/limit pagination. While functional for standard use, as offset values (`skip`) grow extremely large, MongoDB must scan and drop all preceding documents. For long-term scalability, consider migrating to Cursor-Based Pagination using `_id` comparators.

**2. Attachment Sanitization**
The system robustly handles legacy vs. modern payload structures by checking both `attachments` and `files` arrays, filtering out non-string/empty values before database insertion. This is an excellent defensive programming pattern that prevents empty array elements from breaking frontend render logic.

**3. Deep Population Chains**
The `getClassroomById` endpoint executes extensive populations (Teacher, Students, Assignments, Notices, and Notice Creators). Under heavy load, deep population blocks the Node.js event loop. 
*Recommendation:* If the classroom dashboard suffers performance degradation, consider splitting this endpoint so that Assignments and Notices are fetched asynchronously via separate lazy-loaded API calls.