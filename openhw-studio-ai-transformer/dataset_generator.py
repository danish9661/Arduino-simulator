import json
import random
import os

# --- Configuration ---
COMPONENTS = {
    "led": {"types": ["wokwi-led"], "colors": ["red", "green", "blue", "yellow", "white"], "pin": "A"},
    "resistor": {"types": ["wokwi-resistor"], "values": ["220", "330", "1k", "10k"], "pin": "1"},
    "button": {"types": ["wokwi-pushbutton"], "pin": "1.L"},
    "potentiometer": {"types": ["wokwi-potentiometer"], "pin": "SIG"},
    "servo": {"types": ["wokwi-servo"], "pin": "PWM"},
    "buzzer": {"types": ["wokwi-buzzer"], "pin": "1"}
}

BOARDS = ["uno1", "uno2", "pico1", "esp32_1"]
PINS = [str(i) for i in range(14)] + ["A0", "A1", "A2", "GP0", "GP1"]

TEMPLATES = [
    "Add a {color} {name} to pin {pin} of {board}",
    "Connect {name} to {board} pin {pin}",
    "Put a {name} on {board} {pin}",
    "Wire a {value} ohm {name} to {pin} of {board}",
    "I need a {name} connected to {pin} on {board}",
    "Place a {color} {name} and wire it to {board}:{pin}"
]

def generate_sample():
    template = random.choice(TEMPLATES)
    comp_key = random.choice(list(COMPONENTS.keys()))
    comp_info = COMPONENTS[comp_key]
    board = random.choice(BOARDS)
    
    color = random.choice(comp_info.get("colors", ["red"]))
    value = random.choice(comp_info.get("values", ["220"]))
    pin = random.choice(PINS)
    
    text = template.format(
        name=comp_key, 
        color=color, 
        board=board,
        pin=pin,
        value=value
    )
    
    plan = {"actions": []}
    
    # Add component
    action = {
        "type": "add",
        "component": comp_info["types"][0],
        "id": f"{comp_key}_1"
    }
    if "colors" in comp_info: action["color"] = color
    if "values" in comp_info: action["value"] = value
    plan["actions"].append(action)
    
    # Add wire to board
    plan["actions"].append({
        "type": "wire",
        "from": f"{comp_key}_1:{comp_info['pin']}",
        "to": f"{board}:{pin}"
    })
        
    return {"text": text, "plan": plan}

def main(num_samples=5000):
    samples = []
    for _ in range(num_samples):
        samples.append(generate_sample())
        
    output_file = "dataset.jsonl"
    with open(output_file, "w") as f:
        for sample in samples:
            f.write(json.dumps(sample) + "\n")
    
    print(f"Generated {num_samples} samples in {output_file}")

if __name__ == "__main__":
    main()
