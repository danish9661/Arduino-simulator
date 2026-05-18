---
title: Live & Shared Simulation
description: Architectural overview of real-time WebSocket infrastructure and static project sharing.
outline: deep
---

# Live & Shared Simulation

## Shared Simulations (`sharedSimulationController.js`)
The Sharing API allows users to generate standalone clones of their workspace.
* **Payload Normalization:** `normalizeSharedProject` sanitizes the board, components, wires, and code files.
* **Crypto IDs:** Generates a random 12-character hex `shareId`.
* **Access Control:** Defaults to public. If private, the `getSharedSimulation` endpoint cross-references the requester's JWT against the owner ID.

## Live Simulations (`liveSimulationService.js`)
A WebSocket server attached to `/api/live-simulations/ws` enables synchronized teacher-student hardware sessions.

### Event Topology
The WebSocket layer operates on a typed JSON schema:
1. **`session:sync`:** Broadcasts the master `snapshot` (circuit topology + code) to connected clients when an editor makes a change.
2. **`cursor:update`:** Handles real-time presence (mouse/selection coordinates).
3. **`permissions:request`:** A state machine for "passing the chalk." Students request edit access, populating the `pendingEditRequests` array. The teacher can approve/deny, broadcasting the new `permissions:update` state.

### Reconnection & Roster
When `ws.on('close')` fires, the engine removes the client from the `sessionClients` Set and broadcasts a `session:participants` update to re-render the connected user roster.