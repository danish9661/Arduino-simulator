use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use once_cell::sync::Lazy;
use std::sync::Mutex;

// --- Constants ---
const GRID_SIZE: i32 = 10;
const HOLE_PITCH: f32 = 15.0; // Standard breadboard pitch

// --- Data Structures ---

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestPin {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub signals: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Connection {
    pub from: String,
    pub to: String,
    pub via: Option<String>,
    pub attrs: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Autowiring {
    pub connections: Vec<Connection>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AutocodingSnippet {
    pub setup: Option<String>,
    #[serde(rename = "loop")]
    pub loop_code: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Autocoding {
    pub arduino: Option<AutocodingSnippet>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ComponentManifest {
    #[serde(rename = "type")]
    pub kind: String,
    pub pins: Option<Vec<ManifestPin>>,
    pub autowiring: Option<Autowiring>,
    pub autocoding: Option<Autocoding>,
}

#[derive(Clone, Debug)]
pub struct Component {
    pub id: String,
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub pins: Vec<ManifestPin>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WirePlan {
    pub id: String,
    pub from: String,
    pub to: String,
    pub color: String,
    pub path: Option<Vec<Point>>,
    pub is_socket: bool,
    pub is_hidden: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NewComponentPlan {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: Option<String>,
    pub x: f32,
    pub y: f32,
    pub w: Option<f32>,
    pub h: Option<f32>,
    pub attrs: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Serialize, Debug)]
pub struct AutonomousPlan {
    pub main_component: NewComponentPlan,
    pub added_components: Vec<NewComponentPlan>,
    pub added_wires: Vec<WirePlan>,
    pub code_snippet: Option<AutocodingSnippet>,
    pub reasoning: Vec<String>,
}

// --- The Engine Core ---

pub struct Engine {
    pub components: HashMap<String, Component>,
    pub occupancy_grid: HashMap<Point, i32>,
    pub occupied_pins: HashMap<String, Vec<String>>,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            components: HashMap::new(),
            occupancy_grid: HashMap::new(),
            occupied_pins: HashMap::new(),
        }
    }

    pub fn reset(&mut self) {
        self.components.clear();
        self.occupancy_grid.clear();
        self.occupied_pins.clear();
    }

    pub fn build_state(&mut self, existing_wires: Vec<serde_json::Value>) {
        self.occupancy_grid.clear();
        self.occupied_pins.clear();
        for comp in self.components.values() {
            let start_x = (comp.x / GRID_SIZE as f32) as i32;
            let start_y = (comp.y / GRID_SIZE as f32) as i32;
            let end_x = ((comp.x + comp.w) / GRID_SIZE as f32) as i32;
            let end_y = ((comp.y + comp.h) / GRID_SIZE as f32) as i32;
            for x in start_x..=end_x {
                for y in start_y..=end_y {
                    *self.occupancy_grid.entry(Point { x, y }).or_insert(0) += 10;
                }
            }
        }
        for wire in existing_wires {
            if let (Some(from), Some(to)) = (wire.get("from"), wire.get("to")) {
                for p_str in &[from, to] {
                    if let Some(p) = p_str.as_str() {
                        let parts: Vec<&str> = p.split(|c| c == ':' || c == '.').collect();
                        if parts.len() >= 2 {
                            self.occupied_pins.entry(parts[0].to_string()).or_default().push(parts[1].to_string());
                        }
                    }
                }
            }
        }
    }

    pub fn resolve_best_pin(&mut self, board_id: &str, preferred: &str) -> Option<String> {
        let board = self.components.get(board_id)?;
        let occupied = self.occupied_pins.get(board_id);
        
        let is_preferred_taken = occupied.map(|os| os.contains(&preferred.to_string())).unwrap_or(false);
        if !is_preferred_taken {
            self.occupied_pins.entry(board_id.to_string()).or_default().push(preferred.to_string());
            return Some(preferred.to_string());
        }

        let preferred_num: i32 = preferred.parse().unwrap_or(13);
        let mut pins: Vec<i32> = board.pins.iter()
            .filter_map(|p| p.id.parse::<i32>().ok())
            .collect();
        pins.sort_by_key(|p| (p - preferred_num).abs());

        for p_id in pins {
            let p_str = p_id.to_string();
            let is_taken = occupied.map(|os| os.contains(&p_str)).unwrap_or(false);
            if !is_taken {
                self.occupied_pins.entry(board_id.to_string()).or_default().push(p_str.clone());
                return Some(p_str);
            }
        }
        None
    }

    pub fn find_breadboard(&self) -> Option<&Component> {
        self.components.values().find(|c| c.kind.starts_with("wokwi-breadboard"))
    }
}

// --- WASM Interface ---

static ENGINE: Lazy<Mutex<Engine>> = Lazy::new(|| Mutex::new(Engine::new()));

#[wasm_bindgen]
pub fn reset() {
    ENGINE.lock().unwrap().reset();
}

#[wasm_bindgen(js_name = ingestComponent)]
pub fn ingest_component(id: String, kind: String, x: f32, y: f32, w: f32, h: f32, pins_json: JsValue) {
    let mut engine = ENGINE.lock().unwrap();
    let pins: Vec<ManifestPin> = serde_wasm_bindgen::from_value(pins_json).unwrap_or_default();
    engine.components.insert(id.clone(), Component { id, kind, x, y, w, h, pins });
}

#[wasm_bindgen(js_name = generateAutonomousSetup)]
pub fn generate_autonomous_setup(
    new_comp_json: JsValue,
    manifest_json: JsValue,
    board_id: String,
    existing_wires_json: JsValue
) -> JsValue {
    let mut engine = ENGINE.lock().unwrap();
    let existing_wires: Vec<serde_json::Value> = serde_wasm_bindgen::from_value(existing_wires_json).unwrap_or_default();
    engine.build_state(existing_wires);

    let new_comp: NewComponentPlan = match serde_wasm_bindgen::from_value(new_comp_json) {
        Ok(v) => v,
        Err(e) => return JsValue::from_str(&format!("Error parsing newComp: {}", e)),
    };

    let manifest: ComponentManifest = match serde_wasm_bindgen::from_value(manifest_json) {
        Ok(v) => v,
        Err(e) => return JsValue::from_str(&format!("Error parsing manifest: {}", e)),
    };

    let mut plan = AutonomousPlan {
        main_component: new_comp.clone(),
        added_components: Vec::new(),
        added_wires: Vec::new(),
        code_snippet: None,
        reasoning: vec!["WASM Engine: Starting Breadboard-Aware routing.".to_string()],
    };

    // 1. Breadboard Strategy
    let bb = engine.find_breadboard();
    let mut bb_to_add = None;

    if bb.is_none() {
        // Automatically provision a Breadboard based on component count
        let count = engine.components.len();
        let (bb_type, w, h) = if count < 5 { 
            ("wokwi-breadboard-mini", 260.0, 200.0) 
        } else if count < 15 { 
            ("wokwi-breadboard-half", 495.0, 295.0) 
        } else { 
            ("wokwi-breadboard", 920.0, 295.0) 
        };
        
        let bb_id = format!("bb_{}", count);
        
        // Place BB near the drop position
        let b_comp = NewComponentPlan {
            id: bb_id.clone(),
            kind: bb_type.to_string(),
            label: Some("Breadboard".to_string()),
            x: plan.main_component.x - 50.0,
            y: plan.main_component.y - 50.0,
            w: None, h: None, // Frontend will pull actual manifest sizes
            attrs: None,
        };
        bb_to_add = Some(b_comp.clone());
        plan.added_components.push(b_comp);
        plan.reasoning.push(format!("Eye: Automatically provisioned {} for the new circuit.", bb_type));
    }

    // 2. Snapping Logic
    let current_bb = bb.cloned().or_else(|| {
        bb_to_add.map(|b| Component {
            id: b.id, kind: b.kind, x: b.x, y: b.y, w: b.w.unwrap_or(400.0), h: b.h.unwrap_or(300.0), pins: Vec::new()
        })
    });

    if let Some(board) = &current_bb {
        // Snap main component to breadboard hole grid (assuming 15px pitch)
        let local_x = (plan.main_component.x - board.x).max(0.0);
        let local_y = (plan.main_component.y - board.y).max(0.0);
        let snapped_x = (local_x / HOLE_PITCH).round() * HOLE_PITCH + board.x;
        let snapped_y = (local_y / HOLE_PITCH).round() * HOLE_PITCH + board.y;
        
        plan.main_component.x = snapped_x;
        plan.main_component.y = snapped_y;
        plan.reasoning.push(format!("Snap: Locked {} to breadboard hole grid.", plan.main_component.kind));
    }

    // 3. Intelligent Wiring & Resistors
    let mut resolved_pins: HashMap<String, String> = HashMap::new();

    if let Some(autowiring) = manifest.autowiring {
        for (i, conn) in autowiring.connections.iter().enumerate() {
            let mut target = conn.to.clone();
            
            if target.starts_with("arduino:") {
                let preferred = target.replace("arduino:", "");
                if preferred == "GND" {
                    target = format!("{}:GND", board_id);
                } else {
                    if let Some(p) = engine.resolve_best_pin(&board_id, &preferred) {
                        resolved_pins.insert(preferred.clone(), p.clone());
                        target = format!("{}:{}", board_id, p);
                    }
                }
            }

            if manifest.kind == "wokwi-led" && conn.from == "A" {
                let res_id = format!("res_{}", plan.main_component.id);
                
                // --- Advanced Eye: Bridge columns to avoid overlap ---
                // Resistor should be 3-4 holes to the left/right of the LED
                let res_x = plan.main_component.x - HOLE_PITCH * 4.0;
                let res_y = plan.main_component.y + HOLE_PITCH * 2.0;
                
                plan.added_components.push(NewComponentPlan {
                    id: res_id.clone(),
                    kind: "wokwi-resistor".to_string(),
                    label: Some("220R".to_string()),
                    x: res_x, y: res_y,
                    w: Some(70.0), h: Some(32.0),
                    attrs: Some(HashMap::from([("value".to_string(), serde_json::Value::String("220".to_string()))])),
                });

                // Socket connection (Hidden)
                plan.added_wires.push(WirePlan {
                    id: format!("w_auto_{}_res", plan.main_component.id),
                    from: format!("{}:A", plan.main_component.id),
                    to: format!("{}:p1", res_id),
                    color: "orange".to_string(), path: None, is_socket: true, is_hidden: true,
                });
                
                plan.added_wires.push(WirePlan {
                    id: format!("w_auto_{}_pin", plan.main_component.id),
                    from: format!("{}:p2", res_id),
                    to: target,
                    color: "green".to_string(), path: None, is_socket: false, is_hidden: false,
                });
                
                plan.reasoning.push("Safety: Injected 220Ω resistor into snapped breadboard row.".to_string());
                continue;
            }

            plan.added_wires.push(WirePlan {
                id: format!("w_auto_{}_{}", plan.main_component.id, i),
                from: format!("{}:{}", plan.main_component.id, conn.from),
                to: target,
                color: "green".to_string(), path: None, is_socket: false, is_hidden: false,
            });
        }
    }

    // Dynamic Code Generation
    if let Some(autocoding) = manifest.autocoding {
        if let Some(mut snippet) = autocoding.arduino {
            for (pref, real) in resolved_pins {
                if let Some(setup) = &mut snippet.setup {
                    *setup = setup.replace(&pref, &real);
                }
                if let Some(loop_code) = &mut snippet.loop_code {
                    *loop_code = loop_code.replace(&pref, &real);
                }
            }
            plan.code_snippet = Some(snippet);
        }
    }

    serde_wasm_bindgen::to_value(&plan).unwrap()
}
