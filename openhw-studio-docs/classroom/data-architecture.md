---
title: Classroom System Data Architecture
description: Engineering documentation covering database schemas, entity relationships, indexing strategies, and real-time state management for the OpenHW Studio Classroom module.
outline: deep
---

# Classroom System Data Architecture

## Executive Summary
The Classroom System in OpenHW Studio operates on a relational-document hybrid model utilizing MongoDB and Mongoose. The data layer is engineered to support role-based authorization, scalable assignment distribution, isolated hardware simulation payloads, and real-time collaboration states.

This document outlines the core schemas, polymorphic relationships, query optimization strategies, and current architectural constraints.

---

## Entity Relationship Topology

The architecture relies on the `Class` aggregate root, connecting users (actors) to learning materials (assignments/notices) and execution states (submissions/projects).

1. **Identity & Authorization:** `User`, `AuditLog`, `SystemConfig`
2. **Classroom Aggregation:** `Class`, `Notice`, `Comment`
3. **Evaluation Pipeline:** `Assignment` -> `Project` -> `Submission`
4. **Real-Time Synchronization:** `LiveSimulationSession`

---

## Core Implementations & Schema Analysis

### 1. The Aggregate Root: `Class.js`
The `Class` schema acts as the central hub. To optimize read operations for dashboard hydration, it utilizes reference arrays.

**Implementation Details:**
* **Access Control:** Governed by `joinCode` (unique) and the `teacher` reference.
* **Array-Based Relationships:** `students`, `assignments`, and `notices` arrays allow rapid fetching of related metadata without requiring expensive aggregation pipelines across the entire database.

```javascript
// Reference: Class.js
teacher: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
joinCode: { type: String, required: true, unique: true },
students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
assignments: [{ type: mongoose.Schema.Types.ObjectId, ref: "Assignment" }]
```

### 2. The Evaluation Pipeline
The evaluation flow separates instructions, execution, and grading into distinct collections to prevent document bloat and ensure payload isolation.

* **`Assignment.js` (The Template):** Contains the core instructions, due dates, and a `templateProjectId` linking to a base circuit layout.
* **`Project.js` (The Payload):** Stores the actual hardware simulation data (`components`, `connections`, `code`). It uses an `isAssignment` boolean to distinguish between sandbox projects and graded work.
* **`Submission.js` (The Lock):** Bridges the student, the assignment, and the project. 

**Critical Indexing Rule:**
The `Submission` model enforces a strict one-to-one relationship per student per assignment at the database level to prevent race conditions during rapid API calls or auto-grading scripts.

```javascript
// Reference: Submission.js
submissionSchema.index({ assignmentId: 1, studentId: 1 }, { unique: true });
```

### 3. Dual-State Project Architecture
The system employs a dual-state architecture for user projects:
1. **Embedded:** `User.js` contains a `projects` array using `sharedProjectSchema` (with `shareId`, `openCodeTabs`, etc.).
2. **Standalone:** `Project.js` is a dedicated collection.

*Architecture Note:* Embedded projects optimize read times for user profiles and simple scratchpads, while the standalone `Project` collection is utilized for heavy, assignment-bound simulation payloads that require dedicated CRUD operations.

### 4. Real-Time State Persistence: `LiveSimulationSession.js`
Engineered for synchronized teacher-student hardware sessions, this schema avoids heavy relational population by using de-normalized structures.

* **De-normalized Roster:** Uses a nested sub-document array (`studentRoster`) containing both `userId` and `userName`.
* **State Snapshotting:** The `snapshot` field utilizes `mongoose.Schema.Types.Mixed` to store an arbitrary JSON blob of the circuit's current state. This bypasses strict Mongoose casting, enabling rapid, flexible state injection from WebSockets.

### 5. Polymorphic Communications: `Comment.js`
To avoid collection bloat (e.g., `AssignmentComments`, `NoticeComments`), the communication layer uses a polymorphic association.

**Query Optimization:**
The compound index ensures that fetching comments for a specific post within a class operates in O(log N) time.

```javascript
// Reference: Comment.js
postType: { type: String, enum: ["assignment", "notice"], required: true },
commentSchema.index({ classId: 1, postId: 1, postType: 1 });
```

---

## Technical Debt & Engineering Audit

**1. Unbounded Array Risks**
Collections such as `Class` (`students`, `assignments`), `User` (`projects`), and `Project` (`components`, `connections`) utilize unbounded arrays. In MongoDB, documents are restricted to 16MB. High-activity classrooms or extremely complex circuits risk breaching this limit.
*Recommendation:* Implement API-level pagination for classroom rosters and consider transitioning large circuit payloads to an external blob store (e.g., AWS S3) referenced via URI.

**2. Indexing Opportunities**
While `LiveSimulationSession.js` correctly indices `sessionCode` and `classId`, the `Project.js` collection lacks indexing on `userId` and `assignmentId`. As the platform scales, fetching projects for a specific assignment will result in slow collection scans.
*Recommendation:* Add `projectSchema.index({ assignmentId: 1 });` and `projectSchema.index({ userId: 1 });`.