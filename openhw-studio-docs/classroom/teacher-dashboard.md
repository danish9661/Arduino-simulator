---
title: Teacher Dashboard UI Architecture
description: Technical documentation of the React component hierarchy, state management, container patterns, and web worker integrations powering the Teacher Classroom Dashboard.
outline: deep
---

# Teacher Dashboard UI Architecture

## Executive Summary
The Teacher Dashboard serves as the command center for the Classroom System. It is a highly modular React interface designed to handle real-time roster management, assignment distribution, multipart asset uploading, and automated grading configuration. 

The architecture follows a strict **Container/Presenter pattern**. High-level Page components manage data fetching, state orchestration, and API interactions, while pure Presentational components handle the UI rendering. Additionally, the heavy lifting of behavioral circuit validation is delegated to dedicated Web Workers to prevent blocking the main browser UI thread.

---

## Page-Level Controllers (The Containers)

The routing layer maps directly to three primary container components that manage the global state for the teacher experience.

### 1. `TeacherDashboard.jsx` (Global Entry)
This is the root view upon login. It fetches the user's active roster of classrooms (`getMyClassrooms`) and renders them via `ClassCard` components.
* **Core Responsibility:** Managing the "Create Class" lifecycle, including multipart image uploads for the classroom banner via `uploadClassroomFiles` before sending the payload to the backend.

### 2. `TeacherClassDetailPage.jsx` (The Orchestrator)
This is a massive "God Component" that acts as the state manager for a specific classroom (`/:classId`). 
* **State Management:** It maintains the active tab state (`stream`, `classwork`, `people`, `marks`) and the visibility states for four distinct modals: `TeacherComposerModal`, `TeacherEditClassModal`, `ClassroomFilePreviewModal`, and `TeacherAssignmentSubmissionsModal`.
* **API Delegation:** All CRUD operations for assignments, notices, and students are executed here and passed down as callbacks to the presentational layers.

### 3. `TeacherProfilePage.jsx` (Identity & Session)
Manages the teacher's localized session data. It interfaces with the `updateProfile` API to sync academic biographies, credentials, and profile images, ensuring the UI reflects the most current JWT claims.

---

## Component Hierarchy & Layout

Beneath the `TeacherClassDetailPage` orchestrator, the dashboard utilizes a classic three-pane layout with dynamic modals.

* **`TeacherClassHeader`**: Manages the classroom hero banner, high-level settings, and the primary navigation tabs.
* **`TeacherClassSidebar`**: The right-hand quick-action panel. Handles the initialization of WebRTC/WebSocket syncs via the "Start Live Meeting" action, exposes the `joinCode`, and displays upcoming assignment deadlines.
* **`TeacherClassMainContent`**: The dynamic render target for the active tab.

---

## Core Tab Workflows

### 1. The Stream (`TeacherStreamTab`)
Acts as the central noticeboard. Teachers can dispatch quick announcements via a unified input box. Posts trigger the `createNotice` API, supporting rich text and file attachments via `ClassroomAttachmentBlock`.

### 2. Classwork Management (`TeacherClassworkTab`)
Renders the assignment pipeline.
* **Metric Aggregation:** Each assignment card calculates real-time completion statistics (e.g., `submittedCount` vs `classStudentCount`) passed down via the `assignmentMetrics` prop.
* **State Badges:** Dynamically tags assignments as `Open` or `Closed` based on the current date relative to the `dueDate`. Assignments configured with reference keys are visibly tagged with an `Autograde` badge.

### 3. Roster Control (`TeacherPeopleTab`)
A specialized view for identity management. Includes client-side fuzzy searching against student names and emails, and handles the asynchronous eviction of students via the `removeClassroomStudent` API workflow.

---

## The Autograding Pipeline (Web Worker Integration)

The most complex frontend workflow occurs when a teacher creates an autograded assignment using `TeacherComposerModal` and the embedded `TeacherGradingPanel`.

### 1. Reference Circuit Extraction
Instead of uploading raw JSON, teachers upload a standard PNG of their "Correct" circuit. The `extractProjectMetaFromPng` utility reads the custom steganographic chunks embedded in the image to reconstruct the circuit metadata.

### 2. Off-Thread Behavioral Audit
Because circuit compilation and simulation are computationally expensive, the UI spawns a Web Worker (`grading-engine.worker.ts`). 

```javascript
// Initialization of the Web Worker in TeacherGradingPanel
workerRef.current = new Worker(
  new URL('../../../worker/grading-engine.worker.ts', import.meta.url), 
  { type: 'module' }
);
```

**The Stepper State Machine:**
The UI listens to `type: 'LOG'` messages from the worker to advance the visual stepper state:
1. `EXTRACTING`: Metadata extraction.
2. `VALIDATING`: Structural logic checks.
3. `COMPILING`: C++ / Assembly compilation payload prep.
4. `SIMULATING`: Headless hardware execution (tracked by `simSeconds` timer).
5. `REPORTING`: Finalizing the binary key.

### 3. Cryptographic Key Generation
Upon a successful `GRADING_COMPLETE` message from the worker, the raw binary buffer (the verified logic signature of the circuit) is converted to a Base64 string and stored in the assignment form state as `autogradingKey`. This key is later passed to the backend and used by students to validate their own circuits.

---

## Submission Review Workflow

The `TeacherAssignmentSubmissionsModal` provides a dual-pane interface for grading.

* **Left Pane (Roster Selection):** Iterates over the `submissions` array. Calculates file counts and link counts on the fly. Maintains the `selectedSubmissionId` state.
* **Right Pane (Submission Detail):** Renders the specific student's payload. 
  * **Simulation Links:** If the student provided a raw `simulationUrl` or a system-generated `simulationShareId`, the UI automatically formats it into an active simulator preview link.
  * **File Previews:** Reuses the `ClassroomAttachmentBlock` to securely render PDFs and images without forcing a direct download.

---

## Technical Debt & UI Constraints

1. **Memory Leaks on Worker Termination:** The `TeacherGradingPanel` uses a `useEffect` cleanup function to call `workerRef.current.terminate()`. However, if the component unmounts mid-compilation, the Web Worker might orphan network requests to the backend `/compile` endpoint. 
2. **Prop Drilling in the Container Pattern:** `TeacherClassDetailPage.jsx` manages the state for almost every sub-component and modal in the classroom view. Passing all these state variables and handler functions down multiple levels of the component tree makes the codebase brittle. 
    * *Recommendation:* Refactor `TeacherClassDetailPage` to utilize a `ClassroomContext` or Redux slice to cleanly inject state directly into the modals that need it.