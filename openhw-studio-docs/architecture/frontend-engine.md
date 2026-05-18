---
title: Simulator Frontend Engine
description: Details the React Canvas rendering, geometric wire routing, and Wokwi import bridges.
outline: deep
---

# Simulator Frontend Engine

## Canvas & Scene Rendering
The visual circuit board is rendered via a custom React layer (`CanvasSceneLayer.jsx` and `CanvasPrimitives.jsx`).

* **Layering:** Components are separated into Breadboards (rendered first, in the back) and standard components (rendered on top).
* **Ghost Rendering:** Integrates with the `autofixPlan` to render "Ghost" components—semi-transparent overlays showing the user where a missing component should be placed.

## Wire Routing Logic (`wireUtils.js`)
Wires are not just straight lines; they are geometrically routed SVG paths.
* **Orthogonal Routing:** `computeWireOrthoPoints` calculates 90-degree bends to keep schematics clean.
* **Bezier Smoothing:** `renderRoundedPath` applies a standard 10px radius to orthogonal corners to mimic physical jumper wires.
* **Semantic Coloring:** The `wireColor()` function automatically colors wires based on the target pin label (e.g., `GND`/`VSS` = Black, `5V`/`VCC` = Red, `SDA` = Blue, `SCL` = Yellow).

## Ecosystem Bridge (`wokwiImportUtils.js`)
OpenHW Studio maintains compatibility with Wokwi. 
* The utility unzips Wokwi project files, parses `diagram.json`, and normalizes it into OpenHW's internal component schema via `normalizeImportedCircuitData`.