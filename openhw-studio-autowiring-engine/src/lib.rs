use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use once_cell::sync::Lazy;
use std::sync::Mutex;

// ─── Constants ────────────────────────────────────────────────────────────────
const GRID_SIZE:  i32 = 10;
const HOLE_PITCH: f32 = 15.0;

// ─── Data Structures ──────────────────────────────────────────────────────────
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Point { pub x: i32, pub y: i32 }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestPin {
    pub id:      String,
    pub x:       f32,
    pub y:       f32,
    #[serde(rename = "type", default)]
    pub pin_type: String,
    pub signals: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Connection {
    pub from:  String,
    pub to:    String,
    pub via:   Option<String>,
    pub color: Option<String>,
    pub attrs: Option<HashMap<String, serde_json::Value>>,
    pub i2c:   Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HelperDefinition {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub label: Option<String>,
    pub attrs: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Autowiring {
    pub connections: Vec<Connection>,
    pub helpers: Option<Vec<HelperDefinition>>,
    #[serde(rename = "externalPower", default)]
    pub external_power: Option<bool>,
    #[serde(rename = "externalVoltage", default)]
    pub external_voltage: Option<String>,
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
    pub kind:       String,
    pub pins:       Option<Vec<ManifestPin>>,
    pub autowiring: Option<Autowiring>,
    pub autocoding: Option<Autocoding>,
}

#[derive(Clone, Debug)]
pub struct Component {
    pub id:   String,
    pub kind: String,
    pub x:    f32,
    pub y:    f32,
    pub w:    f32,
    pub h:    f32,
    pub pins: Vec<ManifestPin>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WirePlan {
    pub id:        String,
    pub from:      String,
    pub to:        String,
    pub color:     String,
    #[serde(alias = "waypoints")]
    pub path:      Option<Vec<Point>>,
    pub is_socket: bool,
    pub is_hidden: bool,
    pub lane:      i32,
}

fn is_none_or_empty(s: &Option<String>) -> bool {
    s.as_ref().map(|x| x.is_empty()).unwrap_or(true)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NewComponentPlan {
    pub id:    String,
    #[serde(rename = "type")]
    pub kind:  String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub x:     f32,
    pub y:     f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w:     Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h:     Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attrs: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AutonomousPlan {
    pub main_component:  NewComponentPlan,
    pub added_components: Vec<NewComponentPlan>,
    pub added_wires:     Vec<WirePlan>,
    pub removed_wires:   Vec<String>,
    pub removed_components: Vec<String>,
    pub code_snippet:    Option<AutocodingSnippet>,
    pub reasoning:       Vec<String>,
}

// ─── Engine ───────────────────────────────────────────────────────────────────
pub struct Engine {
    pub components:     HashMap<String, Component>,
    pub occupancy_grid: HashMap<Point, i32>,
    pub occupied_pins:  HashMap<String, Vec<String>>,
    pub occupied_rows:  Vec<i32>,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            components:     HashMap::new(),
            occupancy_grid: HashMap::new(),
            occupied_pins:  HashMap::new(),
            occupied_rows:  Vec::new(),
        }
    }

    pub fn reset(&mut self) {
        self.components.clear();
        self.occupancy_grid.clear();
        self.occupied_pins.clear();
        self.occupied_rows.clear();
    }

    pub fn build_state(&mut self, existing_wires: Vec<serde_json::Value>, rewire_id: Option<&String>) -> (Vec<String>, Vec<String>, usize) {
        self.occupancy_grid.clear();
        self.occupied_pins.clear();
        self.occupied_rows.clear();

        let mut removed_wires = Vec::new();
        let mut removed_components = Vec::new();
        let mut processed_wire_count = 0;

        // 1. Identify helper components to remove if re-wiring
        if let Some(rid) = rewire_id {
            let helpers: Vec<String> = self.components.keys()
                .filter(|id| id.contains(&format!("_{}_", rid)) || id.contains(&format!("_{}", rid)))
                .cloned()
                .collect();
            for h in helpers {
                removed_components.push(h.clone());
                self.components.remove(&h);
            }
        }

        // 2. Occupancy & Wire Removal
        for comp in self.components.values() {
            let sx = (comp.x / GRID_SIZE as f32) as i32;
            let sy = (comp.y / GRID_SIZE as f32) as i32;
            let ex = ((comp.x + comp.w) / GRID_SIZE as f32) as i32;
            let ey = ((comp.y + comp.h) / GRID_SIZE as f32) as i32;
            for gx in sx..=ex { for gy in sy..=ey {
                *self.occupancy_grid.entry(Point { x: gx, y: gy }).or_insert(0) += 10;
            }}
        }

        for wire in &existing_wires {
            let from_str = wire.get("from").and_then(|v| v.as_str()).unwrap_or("");
            let to_str = wire.get("to").and_then(|v| v.as_str()).unwrap_or("");
            let wire_id = wire.get("id").and_then(|v| v.as_str()).unwrap_or("");

            if let Some(rid) = rewire_id {
                let from_id = from_str.split(':').next().unwrap_or("");
                let to_id = to_str.split(':').next().unwrap_or("");
                
                // Remove if connected to the main component OR any identified helper
                if from_id == rid || to_id == rid || 
                   removed_components.contains(&from_id.to_string()) || 
                   removed_components.contains(&to_id.to_string()) {
                    removed_wires.push(wire_id.to_string());
                    continue; 
                }
            }

            processed_wire_count += 1;
            for ps in &[from_str, to_str] {
                if !ps.is_empty() && ps.contains(':') {
                    let parts: Vec<&str> = ps.splitn(2, ':').collect();
                    if parts.len() == 2 {
                        let comp_id = parts[0].to_string();
                        let pin_id = parts[1].to_string();
                        
                        let clean_pin = pin_id.split('.').next().unwrap_or(&pin_id).to_string();
                        self.occupied_pins.entry(comp_id).or_default().push(clean_pin.clone());

                        if let Some(num_str) = clean_pin.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<i32>().ok() {
                            if !self.occupied_rows.contains(&num_str) {
                                self.occupied_rows.push(num_str);
                            }
                        }
                    }
                }
            }
        }
        (removed_wires, removed_components, processed_wire_count)
    }

    pub fn pin_exists(&self, board_id: &str, pin_id: &str) -> bool {
        if let Some(board) = self.components.get(board_id) {
            return board.pins.iter().any(|p| p.id == pin_id);
        }
        false
    }

    pub fn is_pin_taken(&self, comp_id: &str, pin_id: &str, plan: &mut AutonomousPlan) -> bool {
        // 0. Buses are never "taken"
        let upin = pin_id.to_uppercase();
        if upin == "GND" || upin == "VCC" || upin == "5V" || upin == "3V3" || upin == "12V" || upin == "VIN" || upin == "VBUS" {
            return false;
        }

        // 1. Check existing wires (already on the board)
        let mut is_taken = false;
        if let Some(taken) = self.occupied_pins.get(comp_id) {
            // Handle potential multi-pin list in existing state (unlikely but safe)
            if pin_id.contains('|') {
                is_taken = pin_id.split('|').all(|p| taken.contains(&p.to_string()));
            } else if taken.contains(&pin_id.to_string()) { 
                is_taken = true;
            }
        }
        
        // 2. Check newly added wires in the current plan
        if !is_taken {
            let full_prefix = format!("{}:", comp_id);
            let pins_to_check: Vec<&str> = if pin_id.contains('|') { pin_id.split('|').collect() } else { vec![pin_id] };
            
            if plan.added_wires.iter().any(|w| {
                pins_to_check.iter().any(|&p| {
                    let suffix = format!(":{}", p);
                    w.from == format!("{}{}", full_prefix, p) || 
                    w.to == format!("{}{}", full_prefix, p) ||
                    w.from.ends_with(&suffix) && w.from.starts_with(&full_prefix) ||
                    w.to.ends_with(&suffix) && w.to.starts_with(&full_prefix)
                })
            }) {
                is_taken = true;
            }
        }
        
        // Debug Log
        if pin_id.starts_with("OUT") || pin_id.starts_with("IN") || pin_id.starts_with("EN") {
            plan.reasoning.push(format!("DEBUG: is_pin_taken({}, {}) -> {}", comp_id, pin_id, if is_taken { "BUSY" } else { "FREE" }));
        }
        
        is_taken
    }

    pub fn resolve_bus_pair(&mut self, board_id: &str, bus_type: &str, plan: &mut AutonomousPlan) -> Option<(String, String, String, i32)> {
        let is_pico = self.components.get(board_id)?.kind.contains("pico");
        
        if bus_type == "i2c" {
            let pairs = if is_pico {
                vec![
                    ("GP4", "GP5", "", 0), ("GP0", "GP1", "", 0), ("GP8", "GP9", "", 0), ("GP12", "GP13", "", 0), ("GP20", "GP21", "", 0),
                    ("GP6", "GP7", "", 1), ("GP2", "GP3", "", 1), ("GP10", "GP11", "", 1), ("GP14", "GP15", "", 1), ("GP26", "GP27", "", 1),
                ]
            } else {
                vec![("A4", "A5", "", 0)]
            };
            for (p1, p2, p3, idx) in pairs {
                if !self.is_pin_taken(board_id, p1, plan) && !self.is_pin_taken(board_id, p2, plan) {
                    return Some((p1.to_string(), p2.to_string(), p3.to_string(), idx));
                }
            }
        } else if bus_type == "spi" {
            let groups = if is_pico {
                vec![
                    ("GP18", "GP19", "GP16", 0), ("GP2", "GP3", "GP0", 0), ("GP6", "GP7", "GP4", 0), ("GP10", "GP11", "GP8", 0),
                    ("GP22", "GP23", "GP20", 0), ("GP26", "GP27", "GP24", 0),
                    ("GP14", "GP15", "GP12", 1), ("GP10", "GP11", "GP8", 1), ("GP2", "GP3", "GP0", 1), ("GP6", "GP7", "GP4", 1),
                ]
            } else {
                vec![("13", "11", "12", 0)] // Uno SPI: 13=SCK, 11=MOSI, 12=MISO
            };
            for (sck, mosi, miso, idx) in groups {
                if !self.is_pin_taken(board_id, sck, plan) && !self.is_pin_taken(board_id, mosi, plan) && !self.is_pin_taken(board_id, miso, plan) {
                    return Some((sck.to_string(), mosi.to_string(), miso.to_string(), idx));
                }
            }
        }
        None
    }


    /// Find the best free pin on the board, starting at `preferred`.
    /// Supports numeric digital pins and analog pins (A0-A5).
    pub fn resolve_best_pin(&mut self, board_id: &str, preferred: &str) -> Option<String> {
        let occupied = self.occupied_pins.get(board_id);
        let is_taken = |pid: &str| occupied.map(|os| os.contains(&pid.to_string())).unwrap_or(false);

        let board = self.components.get(board_id)?;
        let is_pico = board.kind.contains("pico") || board.kind.contains("rp2040");
        let is_esp32 = board.kind.contains("esp32");

        let mut preferred_cleaned = preferred.to_string();
        
        // ── Universal Pin Translation Layer ──
        if is_pico {
            match preferred.to_uppercase().as_str() {
                "SDA" | "A4" => preferred_cleaned = "GP4".to_string(),
                "SCL" | "A5" => preferred_cleaned = "GP5".to_string(),
                "PWM" | "6"  => preferred_cleaned = "GP15".to_string(),
                "MOSI" | "11" => preferred_cleaned = "GP19".to_string(),
                "MISO" | "12" => preferred_cleaned = "GP16".to_string(),
                "SCK" | "13"  => preferred_cleaned = "GP18".to_string(),
                "RX" | "0"    => preferred_cleaned = "GP1".to_string(),
                "TX" | "1"    => preferred_cleaned = "GP0".to_string(),
                "A0" => preferred_cleaned = "GP26".to_string(),
                "A1" => preferred_cleaned = "GP27".to_string(),
                "A2" => preferred_cleaned = "GP28".to_string(),
                _ if preferred.chars().all(|c| c.is_numeric()) => {
                    preferred_cleaned = format!("GP{}", preferred);
                }
                _ => {}
            }
        } else if is_esp32 {
            match preferred.to_uppercase().as_str() {
                "SDA" | "A4" => preferred_cleaned = "GPIO21".to_string(),
                "SCL" | "A5" => preferred_cleaned = "GPIO22".to_string(),
                "PWM" | "6"  => preferred_cleaned = "GPIO18".to_string(),
                "A0" => preferred_cleaned = "GPIO36".to_string(),
                _ if preferred.chars().all(|c| c.is_numeric()) => {
                    preferred_cleaned = format!("GPIO{}", preferred);
                }
                _ => {}
            }
        }

        if !is_taken(&preferred_cleaned) {
            self.occupied_pins.entry(board_id.to_string()).or_default().push(preferred_cleaned.clone());
            return Some(preferred_cleaned);
        }

        let mut pins: Vec<String> = board.pins.iter()
            .map(|p| p.id.clone())
            .filter(|id| {
                id.chars().all(|c| c.is_numeric()) || 
                (is_pico && id.starts_with("GP")) || 
                (is_esp32 && id.starts_with("GPIO")) ||
                id.starts_with('A') // Allow A0, A1, etc.
            })
            .collect();
            
        let preferred_num: i32 = preferred.chars().filter(|c| c.is_numeric()).collect::<String>().parse().unwrap_or(13);

        pins.sort_by_key(|id| {
            let n = id.chars().filter(|c| c.is_numeric()).collect::<String>().parse::<i32>().unwrap_or(0);
            (n - preferred_num).abs()
        });

        for p_id in &pins {
            if !is_taken(p_id) {
                self.occupied_pins.entry(board_id.to_string()).or_default().push(p_id.clone());
                return Some(p_id.clone());
            }
        }

        // Try analog pins (Board Specific)
        let analog_ids = if is_pico { vec!["GP26", "GP27", "GP28"] } 
                         else { vec!["A0","A1","A2","A3","A4","A5"] };
        for ap in &analog_ids {
            if board.pins.iter().any(|p| p.id == *ap) && !is_taken(ap) {
                self.occupied_pins.entry(board_id.to_string()).or_default().push(ap.to_string());
                return Some(ap.to_string());
            }
        }
        None
    }

    pub fn find_nearest_board(&self, x: f32, y: f32) -> Option<String> {
        self.components.values()
            .filter(|c| c.kind.contains("arduino") || c.kind.contains("esp32") || c.kind.contains("pico") || c.kind.contains("rp2040") || c.kind.contains("stm32"))
            .min_by(|a, b| {
                let da = (a.x - x).hypot(a.y - y);
                let db = (b.x - x).hypot(b.y - y);
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|c| c.id.clone())
    }

    pub fn find_breadboard(&self) -> Option<&Component> {
        self.components.values().find(|c| c.kind.starts_with("wokwi-breadboard"))
    }

    /// Check if a proposed bounding box overlaps existing components.
    pub fn has_collision(&self, x: f32, y: f32, w: f32, h: f32, exclude_id: &str) -> bool {
        for comp in self.components.values() {
            if comp.id == exclude_id { continue; }
            let margin = 5.0;
            if x < comp.x + comp.w + margin && x + w + margin > comp.x &&
               y < comp.y + comp.h + margin && y + h + margin > comp.y {
                return true;
            }
        }
        false
    }

    /// Find a free position for a helper near (want_x, want_y).
    pub fn free_helper_position(&self, want_x: f32, want_y: f32, w: f32, h: f32, align_y: Option<f32>) -> (f32, f32) {
        let mut cx = want_x; 
        let mut cy = align_y.unwrap_or(want_y);
        for attempt in 0..20 {
            if !self.has_collision(cx, cy, w, h, "__helper__") { return (cx, cy); }
            cx += HOLE_PITCH;
            if attempt % 5 == 4 { 
                cx = want_x; 
                if align_y.is_none() { cy += HOLE_PITCH * 2.0; }
                else { cy += HOLE_PITCH; } // Smaller jumps if aligned
            }
        }
        (cx, cy)
    }

    /// Snap component by anchor-pin world position to nearest hole grid.
    pub fn snap_to_breadboard_grid(&self, comp_x: &mut f32, comp_y: &mut f32,
                                   anchor_pin: &ManifestPin, bb: &Component) {
        let anchor_world_x = *comp_x + anchor_pin.x;
        let anchor_world_y = *comp_y + anchor_pin.y;
        let local_x = (anchor_world_x - bb.x).max(0.0);
        let local_y = (anchor_world_y - bb.y).max(0.0);
        let snapped_x = (local_x / HOLE_PITCH).round() * HOLE_PITCH + bb.x;
        let snapped_y = (local_y / HOLE_PITCH).round() * HOLE_PITCH + bb.y;
        *comp_x = snapped_x - anchor_pin.x;
        *comp_y = snapped_y - anchor_pin.y;
    }

    /// Universal fallback wiring when no manifest `autowiring` block exists.
    /// Categorises pins by type and auto-routes to the board.
    pub fn universal_fallback_wiring(
        &mut self, comp: &NewComponentPlan, manifest_pins: &[ManifestPin],
        board_id: &str, plan: &mut AutonomousPlan,
    ) {
        let board = match self.components.get(board_id) {
            Some(b) => b,
            None => return,
        };
        let is_pico = board.kind.contains("pico") || board.kind.contains("rp2040");
        let is_esp32 = board.kind.contains("esp32");

        let mut i2c_done = false;
        for (idx, pin) in manifest_pins.iter().enumerate() {
            let pn  = pin.id.to_lowercase();
            let pt  = pin.pin_type.to_lowercase();
            let sig = pin.signals.as_ref().map(|v| v.join(",").to_lowercase()).unwrap_or_default();
            let t   = idx;

            if pt == "power" || pn == "gnd" || pn == "vss" || pn == "0v" {
                plan.added_wires.push(WirePlan {
                    id: format!("w_fallback_gnd_{}_{}", comp.id, t),
                    from: format!("{}:{}", comp.id, pin.id),
                    to: format!("{}:GND", board_id),
                    color: "black".to_string(), path: None, is_socket: false, is_hidden: false,
                    lane: (idx % 7) as i32,
                });
            } else if pn == "vcc" || pn == "v+" || pn == "5v" || pn == "3v3" || pn == "vdd" {
                let target_v = if is_pico { "VBUS" } else { "5V" };
                plan.added_wires.push(WirePlan {
                    id: format!("w_fallback_vcc_{}_{}", comp.id, t),
                    from: format!("{}:{}", comp.id, pin.id),
                    to: format!("{}:{}", board_id, target_v),
                    color: "red".to_string(), path: None, is_socket: false, is_hidden: false,
                    lane: (idx % 7) as i32,
                });
            } else if pt == "analog" || sig.contains("analog") {
                let pref = if is_pico { "GP26" } else { "A0" };
                if let Some(ap) = self.resolve_best_pin(board_id, pref) {
                    plan.added_wires.push(WirePlan {
                        id: format!("w_fallback_analog_{}_{}", comp.id, t),
                        from: format!("{}:{}", comp.id, pin.id),
                        to: format!("{}:{}", board_id, ap),
                        color: "#38bdf8".to_string(), path: None, is_socket: false, is_hidden: false,
                        lane: (idx % 7) as i32,
                    });
                }
            } else if pt == "input" || pt == "bidirectional" || sig.contains("i2c") || sig.contains("scl") || sig.contains("sda") {
                // I2C pins with Strict Hardware enforcement
                if let Some((sda, scl, _, bus_idx)) = self.resolve_bus_pair(board_id, "i2c", plan) {
                    let target_pin = if pn.contains("sda") || sig.contains("sda") { sda } else { scl };
                    plan.added_wires.push(WirePlan {
                        id: format!("w_fallback_i2c_{}_{}", comp.id, t),
                        from: format!("{}:{}", comp.id, pin.id),
                        to: format!("{}:{}", board_id, target_pin),
                        color: "purple".to_string(), path: None, is_socket: false, is_hidden: false,
                        lane: (idx % 7) as i32,
                    });
                    if !i2c_done {
                        plan.reasoning.push(format!("Strict Routing: Connected I2C to hardware {} (Bus {}).", target_pin, bus_idx));
                        i2c_done = true;
                    }
                } else {
                    plan.reasoning.push(format!("CRITICAL: No Hardware I2C buses available on {} for {}. I2C requires specific pins and cannot use Digital 4/5.", board_id, comp.id));
                }
            } else if pt == "digital" || pt.is_empty() {
                if let Some(p) = self.resolve_best_pin(board_id, "2") {
                    plan.added_wires.push(WirePlan {
                        id: format!("w_fallback_dig_{}_{}", comp.id, t),
                        from: format!("{}:{}", comp.id, pin.id),
                        to: format!("{}:{}", board_id, p),
                        color: "green".to_string(), path: None, is_socket: false, is_hidden: false,
                        lane: (idx % 7) as i32,
                    });
                }
            }
        }
        plan.reasoning.push(format!("Fallback: No autowiring manifest — auto-routed {} pins by type.", manifest_pins.len()));
    }
}

// ─── Global engine singleton ──────────────────────────────────────────────────
static ENGINE: Lazy<Mutex<Engine>> = Lazy::new(|| Mutex::new(Engine::new()));

// ─── WASM exports ─────────────────────────────────────────────────────────────
#[wasm_bindgen]
pub fn reset() { ENGINE.lock().unwrap().reset(); }

#[wasm_bindgen(js_name = ingestComponent)]
pub fn ingest_component(id: String, kind: String, x: f32, y: f32, w: f32, h: f32, pins_json: JsValue) {
    let mut engine = ENGINE.lock().unwrap();
    let pins: Vec<ManifestPin> = serde_wasm_bindgen::from_value(pins_json).unwrap_or_default();
    engine.components.insert(id.clone(), Component { id, kind, x, y, w, h, pins });
}

#[wasm_bindgen(js_name = findNearestBoard)]
pub fn find_nearest_board(x: f32, y: f32) -> Option<String> {
    ENGINE.lock().unwrap().find_nearest_board(x, y)
}

#[wasm_bindgen(js_name = generateAutonomousSetup)]
pub fn generate_autonomous_setup(
    new_comp_json: JsValue,
    manifest_json: JsValue,
    mut board_id: String,
    wires_json: JsValue,
    allow_breadboard: bool,
    is_rewire: bool,
) -> JsValue {
    let mut engine = ENGINE.lock().unwrap();

    // ── 0. Manual Wire Ingestion (Robust via Alias) ──
    let existing_wires: Vec<serde_json::Value> = match serde_wasm_bindgen::from_value(wires_json) {
        Ok(v) => v,
        Err(_) => Vec::new(),
    };
    
    let new_comp: NewComponentPlan = match serde_wasm_bindgen::from_value(new_comp_json) {
        Ok(v) => v,
        Err(e) => return JsValue::from_str(&format!("Error parsing component: {}", e)),
    };

    let rewire_id = if is_rewire { Some(&new_comp.id) } else { None };
    let (removed_wires, removed_components, wire_count) = engine.build_state(existing_wires, rewire_id);

    let manifest: ComponentManifest = match serde_wasm_bindgen::from_value(manifest_json) {
        Ok(v) => v,
        Err(e) => return JsValue::from_str(&format!("Error parsing manifest: {}", e)),
    };

    // Auto-select nearest board if board_id is empty
    if board_id.is_empty() {
        if let Some(near_id) = engine.find_nearest_board(new_comp.x, new_comp.y) {
            board_id = near_id;
        } else {
            board_id = "uno".to_string(); // Fallback
        }
    }

    let mut plan = AutonomousPlan {
        main_component:  new_comp.clone(),
        added_components: Vec::new(),
        added_wires:     Vec::new(),
        removed_wires,
        removed_components,
        code_snippet:    None,
        reasoning:       vec![
            format!("SCAN: Found {} wires in project.", wire_count)
        ],
    };
    let main_id = plan.main_component.id.clone();

    // Memory Dump
    for (cid, pins) in &engine.occupied_pins {
        plan.reasoning.push(format!("SCAN: Component '{}' has busy pins: {:?}", cid, pins));
    }

    let mut lane_counter = 0;

    // ── 1. Breadboard provisioning ────────────────────────────────────────────
    let bb = engine.find_breadboard().cloned();
    let mut bb_to_add: Option<NewComponentPlan> = None;

    if allow_breadboard && bb.is_none() {
        let count = engine.components.len();
        let (bb_type, w, h) = if count < 5  { ("wokwi-breadboard-mini", 320.0, 235.0) }
                              else if count < 15 { ("wokwi-breadboard-half", 495.0, 295.0) }
                              else               { ("wokwi-breadboard",      920.0, 295.0) };
        let bb_id = format!("bb_{}", count);
        let bcomp = NewComponentPlan {
            id: bb_id.clone(), kind: bb_type.to_string(), 
            label: None, // Let frontend handle default labeling
            x: plan.main_component.x - 60.0, y: plan.main_component.y - 60.0,
            w: Some(w), h: Some(h), attrs: None,
        };
        bb_to_add = Some(bcomp.clone());
        plan.added_components.push(bcomp);
        plan.reasoning.push(format!("Provisioned {} automatically.", bb_type));
    }

    // ── 2. Anchor-pin snapping ────────────────────────────────────────────────
    let current_bb_comp = if allow_breadboard {
        bb.clone().or_else(|| bb_to_add.as_ref().map(|b| Component {
            id: b.id.clone(), kind: b.kind.clone(),
            x: b.x, y: b.y, w: b.w.unwrap_or(400.0), h: b.h.unwrap_or(300.0), pins: Vec::new(),
        }))
    } else {
        None
    };

    if let Some(ref bb_comp) = current_bb_comp {
        let anchor_pin = manifest.pins.as_ref()
            .and_then(|pins| {
                // Prefer anchorPin from attrs if available
                pins.iter().next()
            });
        if let Some(ap) = anchor_pin {
            engine.snap_to_breadboard_grid(
                &mut plan.main_component.x, &mut plan.main_component.y, ap, bb_comp,
            );
            plan.reasoning.push(format!("Snapped via anchor pin '{}' to hole grid.", ap.id));
        } else {
            // Crude fallback
            let lx = (plan.main_component.x - bb_comp.x).max(0.0);
            let ly = (plan.main_component.y - bb_comp.y).max(0.0);
            plan.main_component.x = (lx / HOLE_PITCH).round() * HOLE_PITCH + bb_comp.x;
            plan.main_component.y = (ly / HOLE_PITCH).round() * HOLE_PITCH + bb_comp.y;
        }
    }

    // ── 3. Wiring ─────────────────────────────────────────────────────────────
    let mut resolved_pins: HashMap<String, String> = HashMap::new();
    let mut i2c_injected = false;

    if let Some(autowiring) = &manifest.autowiring {
        // ── External Power Supply Injection ──
        if autowiring.external_power.unwrap_or(false) {
            let bb_x = current_bb_comp.as_ref().map(|b| b.x).unwrap_or(100.0);
            let bb_y = current_bb_comp.as_ref().map(|b| b.y).unwrap_or(100.0);
            let raw_x = bb_x - 100.0;
            let raw_y = bb_y + 100.0;
            let (ps_x, ps_y) = engine.free_helper_position(raw_x, raw_y, 60.0, 60.0, None);
            
            let voltage = autowiring.external_voltage.clone().unwrap_or_else(|| "5.0".to_string());
            
            plan.added_components.push(NewComponentPlan {
                id: "powersupply".to_string(), kind: "wokwi-power-supply".to_string(),
                label: Some("Power Supply".to_string()),
                x: ps_x, y: ps_y, w: Some(60.0), h: Some(60.0),
                attrs: Some(serde_json::json!({ "voltage": voltage })),
            });
            plan.added_wires.push(WirePlan {
                id: format!("w_ps_gnd_{}", main_id),
                from: "powersupply:GND".to_string(),
                to: format!("{}:GND", board_id),
                color: "black".to_string(), path: None, is_socket: false, is_hidden: false,
                lane: { let l = lane_counter; lane_counter += 1; l % 7 },
            });
            plan.reasoning.push("Injected external power supply component.".to_string());
        }

        // Specialized Power Supply for Motors (Inductive load)
        if manifest.kind == "wokwi-motor" {
            // Check if we already have a PSU
            let has_psu = engine.components.values().any(|c| c.kind.contains("power-supply")) ||
                         plan.added_components.iter().any(|c| c.kind.contains("power-supply"));
            
            if !has_psu {
                let mut voltage = "12.0".to_string();
                if let Some(helpers) = &autowiring.helpers {
                    if let Some(psu_helper) = helpers.iter().find(|h| h.kind.contains("power-supply")) {
                        if let Some(v) = psu_helper.attrs.as_ref().and_then(|a| a.get("voltage")) {
                             voltage = v.as_str().unwrap_or("12.0").to_string();
                        }
                    }
                }

                let ps_w = 60.0; let ps_h = 60.0;
                let raw_x = new_comp.x + 200.0;
                let raw_y = new_comp.y;
                let (ps_x, ps_y) = engine.free_helper_position(raw_x, raw_y, ps_w, ps_h, Some(raw_y));
                
                plan.added_components.push(NewComponentPlan {
                    id: format!("power-supply_{}", main_id),
                    kind: "wokwi-power-supply".to_string(),
                    label: Some("Power Supply".to_string()),
                    x: ps_x, y: ps_y, w: Some(60.0), h: Some(60.0),
                    attrs: Some(serde_json::json!({ "voltage": voltage })),
                });
            }
        }

        // ── 5. Helper Component Injection ──
        let mut helper_id_map: HashMap<String, String> = HashMap::new();
        if let Some(helpers) = &autowiring.helpers {
            for h in helpers {
                // If it's a shared resource like power supply, try to find existing one first
                let mut target_id = "".to_string();
                // Shared Helper Logic: Look for existing PSU or Motor Driver
                if h.kind.contains("power-supply") {
                    if let Some(existing_psu) = engine.components.values().find(|c| c.kind.contains("power-supply")) {
                        target_id = existing_psu.id.clone();
                        plan.reasoning.push(format!("Reusing existing power supply: {}", target_id));
                    }
                } else if h.kind.contains("motor-driver") {
                    // Find a driver that has either OUT1 or OUT3 free
                    if let Some(existing_driver) = engine.components.values().find(|c| {
                        if !c.kind.contains("motor-driver") { return false; }
                        let taken = engine.occupied_pins.get(&c.id).cloned().unwrap_or_default();
                        let out1_free = !taken.contains(&"OUT1".to_string()) && !taken.contains(&"OUT2".to_string());
                        let out3_free = !taken.contains(&"OUT3".to_string()) && !taken.contains(&"OUT4".to_string());
                        out1_free || out3_free
                    }) {
                        target_id = existing_driver.id.clone();
                        plan.reasoning.push(format!("Sharing existing motor driver: {}", target_id));
                    }
                }

                if target_id == "" {
                    // Create new helper
                    let _used_ids: Vec<String> = engine.components.keys().cloned().chain(plan.added_components.iter().map(|c| c.id.clone())).collect();
                    let new_id = format!("{}_{}", h.kind.replace("wokwi-", ""), new_comp.id);
                    
                    // Basic layout: place helpers to the right of the main component
                    let offset = plan.added_components.len() as f32 + 1.0;
                    let added = NewComponentPlan {
                        id: new_id.clone(),
                        kind: h.kind.clone(),
                        label: Some(h.kind.replace("wokwi-", "").replace("-", " ").to_uppercase().replace("MOTOR DRIVER", "Motor Driver").replace("POWER SUPPLY", "Power Supply")),
                        x: new_comp.x + new_comp.w.unwrap_or(60.0) + (offset * 100.0),
                        y: new_comp.y,
                        w: if h.kind.contains("driver") { Some(80.0) } else if h.kind.contains("supply") { Some(60.0) } else { None },
                        h: if h.kind.contains("driver") { Some(80.0) } else if h.kind.contains("supply") { Some(60.0) } else { None },
                        attrs: h.attrs.clone(),
                    };
                    target_id = new_id;
                    plan.added_components.push(added);
                    plan.reasoning.push(format!("Injected helper: {} ({})", target_id, h.kind));
                } else {
                    // Shared Ownership: DO NOT add to added_components if it already exists
                    // This prevents overriding existing project state with empty attributes
                }
                helper_id_map.insert(h.id.clone(), target_id);
            }
        }

        let mut comp_bus_cache: HashMap<String, (String, String, String, i32)> = HashMap::new();

        for (i, conn) in autowiring.connections.iter().enumerate() {
            let mut target = conn.to.clone();
            let mut resolved_target_pin = "".to_string();

            if target.contains("arduino:") || target.contains("board:") || target.contains("helper:") {
                let original_pref = target.clone();
                let mut preferred = target.replace("arduino:", "").replace("board:", "");
                
                // Universal Fallback: pick the first available pin in the | list
                if preferred.contains('|') {
                    let (prefix, options_str) = if preferred.contains(':') {
                        let last_colon = preferred.rfind(':').unwrap();
                        (preferred[..=last_colon].to_string(), preferred[last_colon+1..].to_string())
                    } else {
                        ("".to_string(), preferred.clone())
                    };

                    let mut found = false;
                    for opt in options_str.split('|') {
                        let candidate_full = format!("{}{}", prefix, opt);
                        let is_taken = if candidate_full.contains("helper:") {
                             let parts: Vec<&str> = candidate_full.split(':').collect();
                             let alias = if parts.len() == 3 { parts[1] } else { parts[0] };
                             let pin_id = if parts.len() == 3 { parts[2] } else { parts[1] };
                             if let Some(real_id) = helper_id_map.get(alias) {
                                 engine.is_pin_taken(real_id, pin_id, &mut plan)
                             } else { false }
                        } else {
                             let pin_id = opt.replace("arduino:", "").replace("board:", "");
                             engine.is_pin_taken(&board_id, &pin_id, &mut plan)
                        };
                        
                        if !is_taken {
                            target = if original_pref.contains(':') {
                                let first_colon = original_pref.find(':').unwrap();
                                format!("{}{}", &original_pref[..=first_colon], candidate_full)
                            } else {
                                candidate_full.clone()
                            };
                            preferred = candidate_full;
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        // If all busy, pick the first one and warn (handled below)
                        preferred = format!("{}{}", prefix, options_str.split('|').next().unwrap_or(""));
                    }
                }
                resolved_target_pin = preferred.clone();
                
                let is_pico = engine.components.get(&board_id).map(|c| c.kind.contains("pico")).unwrap_or(false);

                if preferred.to_lowercase() == "gnd" {
                    target = format!("{}:GND", board_id);
                } else if preferred == "5V" || preferred == "VCC" {
                    if is_pico {
                        target = format!("{}:VBUS", board_id);
                    } else {
                        target = format!("{}:5V", board_id);
                    }
                } else if preferred == "3V3" {
                    target = format!("{}:3V3", board_id);
                } else if preferred.contains(':') {
                    // Resolve helper:alias:pin1|pin2 -> physical_id:best_pin
                    let parts: Vec<&str> = preferred.split(':').collect();
                    plan.reasoning.push(format!("DEBUG: Splitting helper '{}' into {} parts.", preferred, parts.len()));
                    
                    if parts.len() >= 2 {
                        let alias = if parts.len() == 3 { parts[1] } else { parts[0] };
                        let pin_options = if parts.len() == 3 { parts[2] } else { parts[1] };
                        
                        plan.reasoning.push(format!("DEBUG: Alias='{}', Options='{}'", alias, pin_options));
                        
                        if let Some(real_id) = helper_id_map.get(alias) {
                            let mut best_pin = "".to_string();
                            let options: Vec<&str> = pin_options.split('|').collect();
                            plan.reasoning.push(format!("DEBUG: Found {} possible pins.", options.len()));
                            
                            for opt in &options {
                                if !engine.is_pin_taken(real_id, opt, &mut plan) {
                                    best_pin = opt.to_string();
                                    plan.reasoning.push(format!("DEBUG: Selected free pin: {}", best_pin));
                                    break;
                                }
                            }
                            if best_pin.is_empty() && !options.is_empty() {
                                best_pin = options[0].to_string();
                                plan.reasoning.push(format!("WARNING: All target pin options for {} are taken. Defaulting to {} (COLLISION LIKELY)", real_id, best_pin));
                            }
                            target = format!("{}:{}", real_id, best_pin);
                            resolved_pins.insert(original_pref.clone(), format!("{}:{}", real_id, best_pin));
                        }
                    }
                } else {
                    // ── I2C/Bus Awareness for Explicit Manifests ──
                    let bus_type = if conn.from.to_uppercase().contains("SDA") || conn.from.to_uppercase().contains("SCL") || preferred.to_uppercase().contains("SDA") || preferred.to_uppercase().contains("SCL") {
                        Some("i2c")
                    } else if conn.from.to_uppercase().contains("MOSI") || conn.from.to_uppercase().contains("SCK") || conn.from.to_uppercase().contains("MISO") {
                        Some("spi")
                    } else if conn.from.to_uppercase().contains("TX") || conn.from.to_uppercase().contains("RX") {
                        Some("uart")
                    } else {
                        None
                    };

                    if let Some(bt) = bus_type {
                        let bus_info = if let Some(cached) = comp_bus_cache.get(bt) {
                            Some(cached.clone())
                        } else {
                            let res = engine.resolve_bus_pair(&board_id, bt, &mut plan);
                            if let Some(pair) = &res { comp_bus_cache.insert(bt.to_string(), pair.clone()); }
                            res
                        };

                        if let Some((p1, p2, p3, bus_idx)) = bus_info {
                            let upper_from = conn.from.to_uppercase();
                            let upper_pref = preferred.to_uppercase();
                            
                            let resolved = if bt == "i2c" {
                                if upper_from.contains("SDA") || upper_pref.contains("SDA") { p1 } else { p2 }
                            } else if bt == "spi" {
                                if upper_from.contains("SCK") || upper_pref.contains("SCK") || upper_from.contains("CLK") || upper_pref.contains("CLK") { p1 }
                                else if upper_from.contains("MOSI") || upper_pref.contains("MOSI") || upper_from.contains("DIN") || upper_pref.contains("DIN") || upper_from.contains("DN") || upper_pref.contains("DN") { p2 }
                                else if upper_from.contains("MISO") || upper_pref.contains("MISO") || upper_from.contains("DOUT") || upper_pref.contains("DOUT") { p3 }
                                else { p1 } // Fallback
                            } else if bt == "uart" {
                                if upper_from.contains("TX") || upper_pref.contains("TX") { p1 } else { p2 }
                            } else {
                                p1
                            };

                            resolved_pins.insert(original_pref.clone(), resolved.clone());
                            target = format!("{}:{}", board_id, resolved);
                            if !plan.reasoning.iter().any(|r| r.contains("Bus")) {
                                plan.reasoning.push(format!("Strict Routing: Assigned {} hardware (Bus {}) for {}.", bt.to_uppercase(), bus_idx, main_id));
                            }
                        } else {
                            plan.reasoning.push(format!("CRITICAL: No Hardware {} buses available on {} for component {}.", bt.to_uppercase(), board_id, main_id));
                            continue;
                        }
                    } else if let Some(p) = engine.resolve_best_pin(&board_id, &preferred) {
                        resolved_pins.insert(original_pref.clone(), p.clone());
                        target = format!("{}:{}", board_id, p);
                    } else {
                        plan.reasoning.push(format!("CRITICAL: No available pins on {} for connection '{}'.", board_id, preferred));
                        continue; // Skip this wire if no pin found
                    }
                }
            } else if !target.contains(':') && !target.is_empty() {
                // Smart Prepend: If no colon, assume it's a board pin
                target = format!("{}:{}", board_id, target);
            }

            // I2C pull-up injection
            if conn.i2c.unwrap_or(false) && !i2c_injected {
                let bb_x = current_bb_comp.as_ref().map(|b| b.x).unwrap_or(new_comp.x + 100.0);
                let bb_y = current_bb_comp.as_ref().map(|b| b.y).unwrap_or(new_comp.y - 100.0);
                let bb_id_str = current_bb_comp.as_ref().map(|b| b.id.as_str()).unwrap_or("board");

                for (j, (pin_name, rail_idx)) in [("SDA", 8), ("SCL", 10)].iter().enumerate() {
                    let pu_id = format!("pu_{}_{}", pin_name.to_lowercase(), main_id);
                    let pu_w = 70.0; let pu_h = 32.0;
                    let raw_x = bb_x + 30.0 + j as f32 * 90.0;
                    let raw_y = bb_y - 50.0;
                    let (px, py) = engine.free_helper_position(raw_x, raw_y, pu_w, pu_h, None);
                    plan.added_components.push(NewComponentPlan {
                        id: pu_id.clone(), kind: "wokwi-resistor".to_string(),
                        label: Some("Resistor".to_string()),
                        x: px, y: py, w: Some(70.0), h: Some(32.0),
                        attrs: Some(serde_json::json!({ "value": "4700" }))
                    });
                    plan.added_wires.push(WirePlan {
                        id: format!("w_pu_{}_in_{}", pin_name, main_id),
                        from: format!("{}:{}", main_id, pin_name),
                        to:   format!("{}:p1", pu_id),
                        color: "#38bdf8".to_string(), path: None, is_socket: true, is_hidden: true,
                        lane: { let l = lane_counter; lane_counter += 1; l % 7 },
                    });
                    let pu_target = if allow_breadboard {
                        format!("{}:top_vcc_{}", bb_id_str, rail_idx)
                    } else {
                        format!("{}:3V3", board_id)
                    };

                    plan.added_wires.push(WirePlan {
                        id: format!("w_pu_{}_out_{}", pin_name, main_id),
                        from: format!("{}:p2", pu_id),
                        to:   pu_target,
                        color: "red".to_string(), path: None, is_socket: false, is_hidden: false,
                        lane: { let l = lane_counter; lane_counter += 1; l % 7 },
                    });
                }
                i2c_injected = true;
                plan.reasoning.push("I2C: Injected 4.7kΩ pull-up resistors on SDA + SCL.".to_string());
            }

            // Via (helper component like resistor)
            if let Some(via_kind) = &conn.via {
                let res_val = conn.attrs.as_ref()
                    .and_then(|a| a.get("value"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("220");
                let via_id = format!("via_{}_{}_{}", conn.from, main_id, i);
                let raw_x  = plan.main_component.x + HOLE_PITCH * 5.0;
                let raw_y  = plan.main_component.y;
                // Try to align with the component's Y coordinate to keep wires straight
                let (vx, vy) = engine.free_helper_position(raw_x, raw_y, 70.0, 32.0, Some(raw_y));
                plan.added_components.push(NewComponentPlan {
                    id: via_id.clone(), kind: via_kind.clone(),
                    label: Some("Resistor".to_string()),
                    x: vx, y: vy, w: Some(70.0), h: Some(32.0),
                    attrs: Some(serde_json::json!({ "value": res_val })),
                });
                plan.added_wires.push(WirePlan {
                    id: format!("w_via_in_{}_{}", main_id, i),
                    from: format!("{}:{}", main_id, conn.from),
                    to:   format!("{}:p1", via_id),
                    color: "orange".to_string(), path: None, is_socket: true, is_hidden: true,
                    lane: { let l = lane_counter; lane_counter += 1; l % 7 },
                });
                plan.added_wires.push(WirePlan {
                    id: format!("w_via_out_{}_{}", main_id, i),
                    from: format!("{}:p2", via_id),
                    to:   target,
                    color: "green".to_string(), path: None, is_socket: false, is_hidden: false,
                    lane: { let l = lane_counter; lane_counter += 1; l % 7 },
                });
                continue;
            }

            let main_id = plan.main_component.id.clone();
            let mut from_pin = format!("{}:{}", main_id, conn.from);
            if conn.from.starts_with("helper:") {
                let parts: Vec<&str> = conn.from.split(':').collect();
                if parts.len() >= 3 {
                    let alias = parts[1];
                    let pin_options = parts[2];
                    if let Some(real_id) = helper_id_map.get(alias) {
                        let mut best_pin = "".to_string();
                        let options: Vec<&str> = pin_options.split('|').collect();
                        for opt in &options {
                            if !engine.is_pin_taken(real_id, opt, &mut plan) {
                                best_pin = opt.to_string();
                                break;
                            }
                        }
                        // If still empty, fall back to the first option but log a warning (or handle error)
                        if best_pin.is_empty() && !options.is_empty() {
                            best_pin = options[0].to_string();
                            plan.reasoning.push(format!("WARNING: All pin options for {} are taken. Defaulting to {} (COLLISION LIKELY)", real_id, best_pin));
                        }
                        from_pin = format!("{}:{}", real_id, best_pin);
                    }
                }
            }

            plan.added_wires.push(WirePlan {
                id: format!("w_auto_{}_{}", main_id, i),
                from: from_pin.clone(),
                to: if target.contains("arduino:") || target.contains("board:") {
                        format!("{}:{}", board_id, resolved_target_pin)
                    } else if target.contains("helper:") {
                        // For helpers, target is already resolved to physical_id:pin in the loop above
                        target.clone()
                    } else {
                        target.clone()
                    },
                color: if let Some(c) = &conn.color { c.clone() }
                       else if from_pin.contains("VCC") || from_pin.contains("5V") || from_pin.contains("VMOT") || target.contains("5V") { "red".to_string() } 
                       else if from_pin.contains("GND") || target.contains("GND") { "black".to_string() } 
                       else { "green".to_string() },
                path: None, 
                is_socket: if conn.color.is_some() { false } else { from_pin.contains("uno") || target.contains("uno") || from_pin.contains("board") || target.contains("board") },
                is_hidden: false,
                lane: { let l = lane_counter; lane_counter += 1; l % 7 },
            });
        }
    } else {
        // ── Universal fallback ────────────────────────────────────────────────
        let pins_clone = manifest.pins.clone().unwrap_or_default();
        let comp_clone = new_comp.clone();
        let bid = board_id.clone();
        engine.universal_fallback_wiring(&comp_clone, &pins_clone, &bid, &mut plan);

        // Fallback also needs to track if it failed
        if plan.added_wires.is_empty() && !pins_clone.is_empty() {
            plan.reasoning.push(format!("CRITICAL: Fallback wiring failed — no available pins on {} for component {}.", bid, comp_clone.id));
        }
    }

    // ── 4. Code snippet ───────────────────────────────────────────────────────
    if let Some(autocoding) = manifest.autocoding {
        if let Some(mut snippet) = autocoding.arduino {
            for (pref, real) in &resolved_pins {
                if let Some(s) = &mut snippet.setup     { *s = s.replace(pref.as_str(), real.as_str()); }
                if let Some(l) = &mut snippet.loop_code { *l = l.replace(pref.as_str(), real.as_str()); }
            }
            plan.code_snippet = Some(snippet);
        }
    }

    use serde::Serialize;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    plan.serialize(&serializer).unwrap()
}
