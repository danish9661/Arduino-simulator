---
title: Component Lab
description: Documentation for the custom component authoring interface.
outline: deep
---

# Component Lab (`ComponentLab.jsx`)

The Component Lab is a dedicated developer tool within OpenHW Studio that allows advanced users to design and manifest custom electronic components.

## Authoring Features
* **Visual Sizing:** Users can define the physical `width` and `height` of the component on a 15px grid system (`GRID_SIZE = 15`).
* **Pin Mapping:** Users can drop interactive pins onto the component chassis, defining the exact `x`/`y` coordinates, `id`, and spacing.
* **Manifest Generation:** The lab automatically serializes the visual layout into a standardized JSON Manifest. 
* **Exporting:** Users can copy the generated code to their clipboard or download it directly as `manifest.json` for submission to the backend Component Registry.