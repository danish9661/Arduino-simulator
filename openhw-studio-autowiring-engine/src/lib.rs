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
    pub attrs: Option<HashMap<String, serde_json::Value>>,
    pub i2c:   Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Autowiring {
    pub connections: Vec<Connection>,
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
    pub path:      Option<Vec<Point>>,
    pub is_socket: bool,
    pub is_hidden: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NewComponentPlan {
    pub id:    String,
    #[serde(rename = "type")]
    pub kind:  String,
    pub label: Option<String>,
    pub x:     f32,
    pub y:     f32,
    pub w:     Option<f32>,
    pub h:     Option<f32>,
    pub attrs: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Serialize, Debug)]
pub struct AutonomousPlan {
    pub main_component:  NewComponentPlan,
    pub added_components: Vec<NewComponentPlan>,
    pub added_wires:     Vec<WirePlan>,
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

    pub fn build_state(&mut self, existing_wires: Vec<serde_json::Value>) {
        self.occupancy_grid.clear();
        self.occupied_pins.clear();
        self.occupied_rows.clear();

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
            if let (Some(from), Some(to)) = (wire.get("from"), wire.get("to")) {
                for ps in &[from, to] {
                    if let Some(p) = ps.as_str() {
                        let parts: Vec<&str> = p.split(|c| c == ':' || c == '.').collect();
                        if parts.len() >= 2 {
                            self.occupied_pins
                                .entry(parts[0].to_string())
                                .or_default()
                                .push(parts[1].to_string());
                        }
                        // Track occupied breadboard rows (hole ids like "12e")
                        if parts.len() >= 2 {
                            if let Some(num_str) = parts[1].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<i32>().ok() {
                                if !self.occupied_rows.contains(&num_str) {
                                    self.occupied_rows.push(num_str);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// Find the best free pin on the board, starting at `preferred`.
    /// Supports numeric digital pins and analog pins (A0-A5).
    pub fn resolve_best_pin(&mut self, board_id: &str, preferred: &str) -> Option<String> {
        let occupied = self.occupied_pins.get(board_id);
        let is_taken = |pid: &str| occupied.map(|os| os.contains(&pid.to_string())).unwrap_or(false);

        if !is_taken(preferred) {
            self.occupied_pins.entry(board_id.to_string()).or_default().push(preferred.to_string());
            return Some(preferred.to_string());
        }

        let board = self.components.get(board_id)?;
        let preferred_num: i32 = preferred.parse().unwrap_or(13);

        // Try nearby numeric pins
        let mut pins: Vec<i32> = board.pins.iter()
            .filter_map(|p| p.id.parse::<i32>().ok())
            .collect();
        pins.sort_by_key(|p| (p - preferred_num).abs());
        for p_id in &pins {
            let s = p_id.to_string();
            if !is_taken(&s) {
                self.occupied_pins.entry(board_id.to_string()).or_default().push(s.clone());
                return Some(s);
            }
        }

        // Try analog pins
        for ap in &["A0","A1","A2","A3","A4","A5"] {
            if board.pins.iter().any(|p| p.id == *ap) && !is_taken(ap) {
                self.occupied_pins.entry(board_id.to_string()).or_default().push(ap.to_string());
                return Some(ap.to_string());
            }
        }
        None
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
    pub fn free_helper_position(&self, want_x: f32, want_y: f32, w: f32, h: f32) -> (f32, f32) {
        let mut cx = want_x; let mut cy = want_y;
        for attempt in 0..20 {
            if !self.has_collision(cx, cy, w, h, "__helper__") { return (cx, cy); }
            cx += HOLE_PITCH;
            if attempt % 5 == 4 { cx = want_x; cy += HOLE_PITCH * 2.0; }
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
                });
            } else if pn == "vcc" || pn == "v+" || pn == "5v" || pn == "3v3" || pn == "vdd" {
                plan.added_wires.push(WirePlan {
                    id: format!("w_fallback_vcc_{}_{}", comp.id, t),
                    from: format!("{}:{}", comp.id, pin.id),
                    to: format!("{}:5V", board_id),
                    color: "red".to_string(), path: None, is_socket: false, is_hidden: false,
                });
            } else if pt == "analog" || sig.contains("analog") {
                if let Some(ap) = self.resolve_best_pin(board_id, "A0") {
                    plan.added_wires.push(WirePlan {
                        id: format!("w_fallback_analog_{}_{}", comp.id, t),
                        from: format!("{}:{}", comp.id, pin.id),
                        to: format!("{}:{}", board_id, ap),
                        color: "#38bdf8".to_string(), path: None, is_socket: false, is_hidden: false,
                    });
                }
            } else if pt == "input" || pt == "bidirectional" || sig.contains("i2c") || sig.contains("scl") || sig.contains("sda") {
                // I2C pins → fixed A4/A5 on Uno
                let target_pin = if pn.contains("sda") { "A4" } else { "A5" };
                plan.added_wires.push(WirePlan {
                    id: format!("w_fallback_i2c_{}_{}", comp.id, t),
                    from: format!("{}:{}", comp.id, pin.id),
                    to: format!("{}:{}", board_id, target_pin),
                    color: "purple".to_string(), path: None, is_socket: false, is_hidden: false,
                });
                if !i2c_done {
                    plan.reasoning.push("Fallback: Detected I2C pins — connected to A4/A5.".to_string());
                    i2c_done = true;
                }
            } else if pt == "digital" || pt.is_empty() {
                if let Some(p) = self.resolve_best_pin(board_id, "2") {
                    plan.added_wires.push(WirePlan {
                        id: format!("w_fallback_dig_{}_{}", comp.id, t),
                        from: format!("{}:{}", comp.id, pin.id),
                        to: format!("{}:{}", board_id, p),
                        color: "green".to_string(), path: None, is_socket: false, is_hidden: false,
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

#[wasm_bindgen(js_name = generateAutonomousSetup)]
pub fn generate_autonomous_setup(
    new_comp_json: JsValue, manifest_json: JsValue,
    board_id: String, existing_wires_json: JsValue,
) -> JsValue {
    let mut engine = ENGINE.lock().unwrap();
    let existing_wires: Vec<serde_json::Value> =
        serde_wasm_bindgen::from_value(existing_wires_json).unwrap_or_default();
    engine.build_state(existing_wires);

    let new_comp: NewComponentPlan = match serde_wasm_bindgen::from_value(new_comp_json) {
        Ok(v)  => v,
        Err(e) => return JsValue::from_str(&format!("Error parsing newComp: {}", e)),
    };
    let manifest: ComponentManifest = match serde_wasm_bindgen::from_value(manifest_json) {
        Ok(v)  => v,
        Err(e) => return JsValue::from_str(&format!("Error parsing manifest: {}", e)),
    };

    let mut plan = AutonomousPlan {
        main_component:  new_comp.clone(),
        added_components: Vec::new(),
        added_wires:     Vec::new(),
        code_snippet:    None,
        reasoning:       vec!["WASM Engine v2: Breadboard-Aware Routing.".to_string()],
    };

    // ── 1. Breadboard provisioning ────────────────────────────────────────────
    let bb = engine.find_breadboard().cloned();
    let mut bb_to_add: Option<NewComponentPlan> = None;

    if bb.is_none() {
        let count = engine.components.len();
        let (bb_type, w, h) = if count < 5  { ("wokwi-breadboard-mini", 320.0, 235.0) }
                              else if count < 15 { ("wokwi-breadboard-half", 495.0, 295.0) }
                              else               { ("wokwi-breadboard",      920.0, 295.0) };
        let bb_id = format!("bb_{}", count);
        let bcomp = NewComponentPlan {
            id: bb_id.clone(), kind: bb_type.to_string(), label: Some("Breadboard".to_string()),
            x: plan.main_component.x - 60.0, y: plan.main_component.y - 60.0,
            w: Some(w), h: Some(h), attrs: None,
        };
        bb_to_add = Some(bcomp.clone());
        plan.added_components.push(bcomp);
        plan.reasoning.push(format!("Provisioned {} automatically.", bb_type));
    }

    // ── 2. Anchor-pin snapping ────────────────────────────────────────────────
    let current_bb_comp = bb.clone().or_else(|| bb_to_add.as_ref().map(|b| Component {
        id: b.id.clone(), kind: b.kind.clone(),
        x: b.x, y: b.y, w: b.w.unwrap_or(400.0), h: b.h.unwrap_or(300.0), pins: Vec::new(),
    }));

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
            let (ps_x, ps_y) = engine.free_helper_position(raw_x, raw_y, 60.0, 60.0);
            
            let voltage = autowiring.external_voltage.clone().unwrap_or_else(|| "5.0".to_string());
            
            plan.added_components.push(NewComponentPlan {
                id: "powersupply".to_string(), kind: "wokwi-power-supply".to_string(),
                label: Some(format!("{}V DC", voltage)),
                x: ps_x, y: ps_y, w: Some(60.0), h: Some(60.0),
                attrs: Some(HashMap::from([("voltage".to_string(), serde_json::Value::String(voltage))])),
            });
            plan.added_wires.push(WirePlan {
                id: format!("w_ps_gnd_{}", plan.main_component.id),
                from: "powersupply:GND".to_string(),
                to: format!("{}:GND", board_id),
                color: "black".to_string(), path: None, is_socket: false, is_hidden: false,
            });
            plan.reasoning.push("Injected external power supply component.".to_string());
        }

        for (i, conn) in autowiring.connections.iter().enumerate() {
            let mut target = conn.to.clone();

            if target.starts_with("arduino:") {
                let preferred = target.replace("arduino:", "");
                if preferred.to_lowercase() == "gnd" {
                    target = format!("{}:GND", board_id);
                } else if preferred == "5V" || preferred == "3V3" || preferred == "VCC" {
                    target = format!("{}:{}", board_id, preferred);
                } else {
                    if let Some(p) = engine.resolve_best_pin(&board_id, &preferred) {
                        resolved_pins.insert(preferred.clone(), p.clone());
                        target = format!("{}:{}", board_id, p);
                    }
                }
            }

            // I2C pull-up injection
            if conn.i2c.unwrap_or(false) && !i2c_injected {
                let bb_x = current_bb_comp.as_ref().map(|b| b.x).unwrap_or(100.0);
                let bb_y = current_bb_comp.as_ref().map(|b| b.y).unwrap_or(100.0);
                let bb_id_str = current_bb_comp.as_ref().map(|b| b.id.as_str()).unwrap_or("bb_0");

                for (j, (pin_name, rail_idx)) in [("SDA", 8), ("SCL", 10)].iter().enumerate() {
                    let pu_id = format!("pu_{}_{}", pin_name.to_lowercase(), plan.main_component.id);
                    let pu_w = 70.0; let pu_h = 32.0;
                    let raw_x = bb_x + 30.0 + j as f32 * 90.0;
                    let raw_y = bb_y - 50.0;
                    let (px, py) = engine.free_helper_position(raw_x, raw_y, pu_w, pu_h);
                    plan.added_components.push(NewComponentPlan {
                        id: pu_id.clone(), kind: "wokwi-resistor".to_string(),
                        label: Some("4.7k".to_string()),
                        x: px, y: py, w: Some(pu_w), h: Some(pu_h),
                        attrs: Some(HashMap::from([("value".to_string(), serde_json::Value::String("4700".to_string()))])),
                    });
                    plan.added_wires.push(WirePlan {
                        id: format!("w_pu_{}_in_{}", pin_name, plan.main_component.id),
                        from: format!("{}:{}", plan.main_component.id, pin_name),
                        to:   format!("{}:p1", pu_id),
                        color: "#38bdf8".to_string(), path: None, is_socket: true, is_hidden: true,
                    });
                    plan.added_wires.push(WirePlan {
                        id: format!("w_pu_{}_out_{}", pin_name, plan.main_component.id),
                        from: format!("{}:p2", pu_id),
                        to:   format!("{}:top_vcc_{}", bb_id_str, rail_idx),
                        color: "red".to_string(), path: None, is_socket: false, is_hidden: false,
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
                let via_id = format!("via_{}_{}_{}", conn.from, plan.main_component.id, i);
                let raw_x  = plan.main_component.x + HOLE_PITCH * 5.0;
                let raw_y  = plan.main_component.y;
                let (vx, vy) = engine.free_helper_position(raw_x, raw_y, 70.0, 32.0);
                plan.added_components.push(NewComponentPlan {
                    id: via_id.clone(), kind: via_kind.clone(),
                    label: Some(format!("{}R", res_val)),
                    x: vx, y: vy, w: Some(70.0), h: Some(32.0),
                    attrs: Some(HashMap::from([("value".to_string(), serde_json::Value::String(res_val.to_string()))])),
                });
                plan.added_wires.push(WirePlan {
                    id: format!("w_via_in_{}_{}", plan.main_component.id, i),
                    from: format!("{}:{}", plan.main_component.id, conn.from),
                    to:   format!("{}:p1", via_id),
                    color: "orange".to_string(), path: None, is_socket: true, is_hidden: true,
                });
                plan.added_wires.push(WirePlan {
                    id: format!("w_via_out_{}_{}", plan.main_component.id, i),
                    from: format!("{}:p2", via_id),
                    to:   target,
                    color: "green".to_string(), path: None, is_socket: false, is_hidden: false,
                });
                continue;
            }

            plan.added_wires.push(WirePlan {
                id: format!("w_auto_{}_{}", plan.main_component.id, i),
                from: format!("{}:{}", plan.main_component.id, conn.from),
                to:   target,
                color: "green".to_string(), path: None, is_socket: false, is_hidden: false,
            });
        }
    } else {
        // ── Universal fallback ────────────────────────────────────────────────
        let pins_clone = manifest.pins.clone().unwrap_or_default();
        let comp_clone = new_comp.clone();
        let bid = board_id.clone();
        engine.universal_fallback_wiring(&comp_clone, &pins_clone, &bid, &mut plan);
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

    serde_wasm_bindgen::to_value(&plan).unwrap()
}
