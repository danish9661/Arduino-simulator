# 🚀 OpenHW Studio: Custom AI Nano-Transformer Roadmap

This document serves as the master guide for building a specialized, instant AI model for circuit manipulation.

## 🧠 Core Concept
Transform natural language instructions into high-fidelity circuit modifications.
*   **Prompt:** *"Add a potentiometer to A0 and a green LED to pin 5."*
*   **Result:** Instant placement and wiring on the canvas.

---

## 🛠️ Technical Specifications

### 1. Model Architecture
*   **Type:** Encoder-Decoder (T5-Small family).
*   **Parameters:** ~60 Million.
*   **Size:** ~60MB (Quantized to 8-bit).
*   **Engine:** `Transformers.js` (Client-side WASM/WebGPU).

### 2. Training Environment
*   **Hardware Required:** RTX 5050 8GB (or equivalent).
*   **Software:** Python 3.9+, PyTorch, HuggingFace Transformers.
*   **Estimated Training Time:** 2-4 Hours.

### 3. Reliability Layers
To prevent hallucination and broken JSON, we use a **Three-Layer Safety System**:
1.  **Grammar Constraints:** The AI is "locked" into choosing only valid JSON tokens.
2.  **Manifest Injection:** We feed the AI the list of real components available in your simulator.
3.  **Rust Engine Validation:** All AI output is passed through the `openhw-studio-autowiring-engine` (WASM) to ensure the physics/pins are valid.

---

## 📅 Implementation Phases

### Phase 1: The "Digital DNA" (Data)
1.  Navigate to `openhw-studio-ai-transformer`.
2.  Run `python dataset_generator.py`.
3.  This generates `dataset.jsonl` with 5,000 pairs (you can increase this number in the script for better accuracy).

### Phase 2: The "Brain Surgery" (Training)
1.  Install dependencies: `pip install -r requirements.txt`.
2.  Run `python train_model.py`.
3.  Training will use your RTX 5050 and save the result to `./final_model`.
4.  Export to ONNX (for browser):
    `python -m optimum.exporters.onnx --model ./final_model onnx_output/`

### Phase 3: The "Hands" (Integration)
*   Implement `ai-action.worker.ts` in the frontend (Conditional Loading).
*   Add a Command Bar (Ctrl+K) to `SimulatorPage.jsx`.
*   Connect AI output to `calculateProjectPlanApplication()`.

---

## 📈 Expected Accuracy
| Instruction Type | Success Rate | Note |
| :--- | :--- | :--- |
| **Simple Addition** | ~99% | "Add a resistor" |
| **Direct Wiring** | ~96% | "Wire LED to Pin 13" |
| **Bulk Actions** | ~90% | "Add 4 buttons and 4 LEDs" |
| **Complex Logic** | ~80% | "Build a simple traffic light" |

---

## ❓ FAQ
**Q: Will it slow down the simulator?**
**A:** No. It runs in a separate Web Worker. The UI remains 60FPS.

**Q: Can it work offline?**
**A:** Yes. Once the model is downloaded once, it works entirely offline in the browser.

**Q: Does it send my data to a server?**
**A:** No. All processing happens on the user's local CPU/GPU (Privacy First).
