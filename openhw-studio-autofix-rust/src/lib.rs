use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use once_cell::sync::Lazy;
use std::sync::Mutex;
use pathfinding::prelude::astar;

// --- Core Data Structures ---

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug)]
pub struct Component {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

#[derive(Clone, Debug)]
pub struct Wire {
    pub from: String,
    pub to: String,
    pub color: String,
    pub path: Vec<Point>,
}

#[derive(Clone, Debug)]
pub struct Violation {
    pub rule_id: String,
    pub message: String,
    pub component_ids: Vec<String>,
    pub severity: String,
}

// --- Plan Structures (Optimized for JS Interop) ---

#[derive(Serialize, Debug)]
pub struct FixPlan {
    pub description: String,
    pub added_components: Vec<JsComponent>,
    pub added_wires: Vec<JsWire>,
    pub removed_wires: Vec<JsWireShort>,
    pub transformations: Vec<JsTransformation>,
    pub reasoning: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct JsComponent {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

#[derive(Serialize, Debug)]
pub struct JsWire {
    pub from: String,
    pub to: String,
    pub color: String,
    pub path: Option<Vec<Point>>,
}

#[derive(Serialize, Debug)]
pub struct JsWireShort {
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Debug)]
pub struct JsTransformation {
    pub component_id: String,
    pub rotation: f64,
}

// --- Engine Implementation ---

pub struct Engine {
    pub components: HashMap<String, Component>,
    pub wires: Vec<Wire>,
    pub violations: Vec<Violation>,
    pub plans: Vec<FixPlan>,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            components: HashMap::new(),
            wires: Vec::new(),
            violations: Vec::new(),
            plans: Vec::new(),
        }
    }

    pub fn reset(&mut self) {
        self.components.clear();
        self.wires.clear();
        self.violations.clear();
        self.plans.clear();
    }

    pub fn find_path(&self, start_p: Point, end_p: Point) -> Vec<Point> {
        let grid_size: f64 = 10.0;
        let start = GridPos { x: (start_p.x / grid_size).round() as i32, y: (start_p.y / grid_size).round() as i32 };
        let end = GridPos { x: (end_p.x / grid_size).round() as i32, y: (end_p.y / grid_size).round() as i32 };

        let mut obstacles = Vec::new();
        for comp in self.components.values() {
            let margin = 5.0;
            let x1 = ((comp.x - margin) / grid_size).floor() as i32;
            let y1 = ((comp.y - margin) / grid_size).floor() as i32;
            let x2 = ((comp.x + 50.0 + margin) / grid_size).ceil() as i32;
            let y2 = ((comp.y + 50.0 + margin) / grid_size).ceil() as i32;
            obstacles.push((x1, y1, x2, y2));
        }

        let result = astar(
            &start,
            |&p| {
                let mut neighbors = Vec::new();
                for &(dx, dy) in &[(0, 1), (0, -1), (1, 0), (-1, 0)] {
                    let next = GridPos { x: p.x + dx, y: p.y + dy };
                    let mut is_blocked = false;
                    if next != start && next != end {
                        for &(x1, y1, x2, y2) in &obstacles {
                            if next.x >= x1 && next.x <= x2 && next.y >= y1 && next.y <= y2 {
                                is_blocked = true;
                                break;
                            }
                        }
                    }
                    if !is_blocked {
                        neighbors.push((next, 1));
                    }
                }
                neighbors
            },
            |&p| p.distance(&end),
            |&p| p == end,
        );

        match result {
            Some((path, _)) => path.iter().map(|p| Point { x: p.x as f64 * grid_size, y: p.y as f64 * grid_size }).collect(),
            None => vec![start_p, end_p],
        }
    }

    pub fn analyze(&mut self) {
        self.plans.clear();
        
        let violations = self.violations.clone();

        for vio in &violations {
            let rule = vio.rule_id.as_str();
            let msg = vio.message.to_lowercase();

            // --- Pattern 1: Polarity Correction ---
            if rule == "validateReversePolarity" || rule == "validateDiodePolarity" || msg.contains("reverse polarity") {
                if let Some(comp_id) = vio.component_ids.get(0) {
                    if let Some(comp) = self.components.get(comp_id) {
                        self.plans.push(FixPlan {
                            description: format!("Flip polarity of {} to correct reverse bias", comp_id),
                            added_components: Vec::new(),
                            added_wires: Vec::new(),
                            removed_wires: Vec::new(),
                            transformations: vec![JsTransformation {
                                component_id: comp_id.clone(),
                                rotation: (comp.rotation + 180.0) % 360.0,
                            }],
                            reasoning: vec![format!("Detected reverse bias on polarized component: {}", comp_id)],
                        });
                        continue;
                    }
                }
            }

            // --- Pattern 2: Series Resistor Injection ---
            let msg_lc = msg.to_lowercase();
            let rule_lc = rule.to_lowercase();
            if rule_lc.contains("limit") || rule_lc.contains("resistor") || msg_lc.contains("no series resistance") || msg_lc.contains("burn out") {
                 let mut comp_id_to_fix = vio.component_ids.get(0).filter(|s| !s.is_empty()).cloned();
                 
                 // Fallback: extract ID from message "[LED id]" or similar
                 if comp_id_to_fix.is_none() {
                     if let Some(start) = msg.find('[') {
                         if let Some(end) = msg.find(']') {
                             let content = &msg[start+1..end];
                             let parts: Vec<&str> = content.split_whitespace().collect();
                             if parts.len() >= 2 {
                                 comp_id_to_fix = Some(parts[1].to_string());
                             }
                         }
                     }
                 }

                 if let Some(comp_id) = comp_id_to_fix {
                    if let Some(comp) = self.components.get(&comp_id).cloned() {
                        let target_pins = if comp.kind == "wokwi-led" { vec!["A", "K"] } else { vec!["1", "2", "pos", "neg"] };
                        
                        let mut wire_to_replace = None;
                        let mut final_target_pin = "1";

                        for pin in target_pins {
                            let target_node = format!("{}:{}", comp_id, pin);
                            for wire in &self.wires {
                                if wire.from == target_node || wire.to == target_node {
                                    wire_to_replace = Some(wire.clone());
                                    final_target_pin = pin;
                                    break;
                                }
                            }
                            if wire_to_replace.is_some() { break; }
                        }

                        if let Some(old_wire) = wire_to_replace {
                            let target_node = format!("{}:{}", comp_id, final_target_pin);
                            let mut plan = FixPlan {
                                description: format!("Insert 220Ω protective resistor for {}", comp_id),
                                added_components: Vec::new(),
                                added_wires: Vec::new(),
                                removed_wires: vec![JsWireShort { from: old_wire.from.clone(), to: old_wire.to.clone() }],
                                transformations: Vec::new(),
                                reasoning: vec![format!("Component {} lacks current limiting. Injecting series resistor.", comp_id)],
                            };

                            let other_end = if old_wire.from == target_node { old_wire.to.clone() } else { old_wire.from.clone() };
                            let res_id = format!("res_{}", comp_id);
                            let res_x = comp.x;
                            let res_y = comp.y - 60.0;
                            
                            plan.added_components.push(JsComponent {
                                id: res_id.clone(),
                                kind: "wokwi-resistor".to_string(),
                                x: res_x,
                                y: res_y,
                                rotation: 0.0,
                            });

                            let start_p = self.get_pin_pos_by_id(&other_end);
                            let mid_p1 = Point { x: res_x, y: res_y + 16.0 };
                            plan.added_wires.push(JsWire {
                                from: other_end,
                                to: format!("{}:1", res_id),
                                color: "red".to_string(),
                                path: Some(self.find_path(start_p, mid_p1)),
                            });

                            let mid_p2 = Point { x: res_x + 70.0, y: res_y + 16.0 };
                            let end_p = self.get_pin_pos(&comp, final_target_pin);
                            plan.added_wires.push(JsWire {
                                from: format!("{}:2", res_id),
                                to: target_node,
                                color: "red".to_string(),
                                path: Some(self.find_path(mid_p2, end_p)),
                            });

                            self.plans.push(plan);
                            continue;
                        }
                    }
                 }
            }

            // --- Pattern 3: I2C Pull-up Infrastructure ---
            if rule == "validateI2CPullups" || msg.contains("sda missing pull-up") || msg.contains("scl missing pull-up") {
                if let Some(mcu_id) = vio.component_ids.get(0) {
                    if let Some(mcu) = self.components.get(mcu_id).cloned() {
                        let mut plan = FixPlan {
                            description: format!("Add 4.7kΩ I2C pull-up resistors for {}", mcu_id),
                            added_components: Vec::new(),
                            added_wires: Vec::new(),
                            removed_wires: Vec::new(),
                            transformations: Vec::new(),
                            reasoning: vec![format!("I2C lines on {} require pull-up resistors for stable communication.", mcu_id)],
                        };

                        let sda_pin = if mcu.kind.contains("pico") { "GP4" } else { "A4" };
                        let scl_pin = if mcu.kind.contains("pico") { "GP5" } else { "A5" };
                        let vcc_pin = if mcu.kind.contains("pico") { "3V3" } else { "5V" };

                        // Spawn 2 resistors
                        for (i, pin) in [sda_pin, scl_pin].iter().enumerate() {
                            let res_id = format!("pullup_{}_{}", mcu_id, i);
                            let res_x = mcu.x + 160.0 + (i as f64 * 80.0);
                            let res_y = mcu.y + 40.0;
                            
                            plan.added_components.push(JsComponent {
                                id: res_id.clone(),
                                kind: "wokwi-resistor".to_string(),
                                x: res_x,
                                y: res_y,
                                rotation: 90.0, // Vertical
                            });

                            // Wire 1: MCU Pin -> Resistor p1
                            let p_start = self.get_pin_pos(&mcu, pin);
                            let p_mid = Point { x: res_x + 16.0, y: res_y };
                            plan.added_wires.push(JsWire {
                                from: format!("{}:{}", mcu_id, pin),
                                to: format!("{}:1", res_id),
                                color: "green".to_string(),
                                path: Some(self.find_path(p_start, p_mid)),
                            });

                            // Wire 2: Resistor p2 -> MCU VCC
                            let p_mid2 = Point { x: res_x + 16.0, y: res_y + 70.0 };
                            let p_vcc = self.get_pin_pos(&mcu, vcc_pin);
                            plan.added_wires.push(JsWire {
                                from: format!("{}:2", res_id),
                                to: format!("{}:{}", mcu_id, vcc_pin),
                                color: "red".to_string(),
                                path: Some(self.find_path(p_mid2, p_vcc)),
                            });
                        }
                        self.plans.push(plan);
                        continue;
                    }
                }
            }

            // --- Pattern 4: Voltage Divider (Over-voltage Protection) ---
            if rule == "validateRp2040VoltageInputs" || msg.contains("exceeds 3.3v logic limit") {
                if let Some(comp_id) = vio.component_ids.get(0) {
                    if let Some(comp) = self.components.get(comp_id).cloned() {
                        // Extract pin from message if possible (e.g., "Over-voltage on GP0")
                        let target_pin = if msg.contains("gp") {
                            msg.split("on ").nth(1).and_then(|s| s.split(':').next()).unwrap_or("1")
                        } else { "1" };
                        let target_node = format!("{}:{}", comp_id, target_pin);

                        let mut wire_to_replace = None;
                        for wire in &self.wires {
                            if wire.from == target_node || wire.to == target_node {
                                wire_to_replace = Some(wire.clone());
                                break;
                            }
                        }

                        if let Some(old_wire) = wire_to_replace {
                            let mut plan = FixPlan {
                                description: format!("Add voltage divider to protect {} pin {}", comp_id, target_pin),
                                added_components: Vec::new(),
                                added_wires: Vec::new(),
                                removed_wires: vec![JsWireShort { from: old_wire.from.clone(), to: old_wire.to.clone() }],
                                transformations: Vec::new(),
                                reasoning: vec![format!("Pin {} is 3.3V only. 5V signal detected. Injecting voltage divider.", target_pin)],
                            };

                            let other_end = if old_wire.from == target_node { old_wire.to.clone() } else { old_wire.from.clone() };
                            let r1_id = format!("vd1_{}", comp_id);
                            let r2_id = format!("vd2_{}", comp_id);
                            
                            // Place resistors in a divider formation
                            plan.added_components.push(JsComponent {
                                id: r1_id.clone(), kind: "wokwi-resistor".to_string(),
                                x: comp.x - 100.0, y: comp.y - 40.0, rotation: 0.0,
                            });
                            plan.added_components.push(JsComponent {
                                id: r2_id.clone(), kind: "wokwi-resistor".to_string(),
                                x: comp.x - 100.0, y: comp.y + 40.0, rotation: 90.0,
                            });

                             // Wire 1: Source -> R1:1
                             plan.added_wires.push(JsWire {
                                 from: other_end.clone(), to: format!("{}:1", r1_id), color: "orange".to_string(),
                                 path: Some(self.find_path(self.get_pin_pos_by_id(&other_end), Point { x: comp.x - 100.0, y: comp.y - 40.0 + 16.0 })),
                             });
 
                             // Wire 2: R1:2 -> MCU Pin
                             plan.added_wires.push(JsWire {
                                 from: format!("{}:2", r1_id), to: target_node.clone(), color: "green".to_string(),
                                 path: Some(self.find_path(Point { x: comp.x - 30.0, y: comp.y - 40.0 + 16.0 }, self.get_pin_pos(&comp, target_pin))),
                             });
 
                             // Wire 3: R1:2 -> R2:1 (Divider tap)
                             plan.added_wires.push(JsWire {
                                 from: format!("{}:2", r1_id), to: format!("{}:1", r2_id), color: "green".to_string(),
                                 path: None,
                             });
 
                             // Wire 4: R2:2 -> GND
                             if let Some(board) = self.find_board() {
                                 plan.added_wires.push(JsWire {
                                     from: format!("{}:2", r2_id), to: format!("{}:GND", board.id), color: "black".to_string(),
                                     path: Some(self.find_path(Point { x: comp.x - 100.0 + 16.0, y: comp.y + 110.0 }, self.get_pin_pos(&board, "GND"))),
                                 });
                             }

                            self.plans.push(plan);
                            continue;
                        }
                    }
                }
            }

             if rule == "validateShortCircuits" || msg.contains("short circuit") {
                 let mut plan = FixPlan {
                     description: "Remove short circuit wire".to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Detected direct wire between power and ground rails. Suggesting removal.".to_string()],
                 };
                 let mut wire_to_remove = None;
                 for w in &self.wires {
                     let f_vcc = w.from.contains("5V") || w.from.contains("VCC") || w.from.contains("3V3");
                     let t_vcc = w.to.contains("5V") || w.to.contains("VCC") || w.to.contains("3V3");
                     let f_gnd = w.from.contains("GND");
                     let t_gnd = w.to.contains("GND");
                     if (f_vcc && t_gnd) || (t_vcc && f_gnd) {
                         wire_to_remove = Some(w.clone());
                         break;
                     }
                 }
                 if let Some(w) = wire_to_remove {
                     plan.removed_wires.push(JsWireShort { from: w.from, to: w.to });
                     self.plans.push(plan);
                     continue;
                 }
             }

             if rule == "validateLogicLevels" || msg.contains("logic mismatch") {
                 if let Some(comp_id) = vio.component_ids.get(0) {
                    if let Some(comp) = self.components.get(comp_id).cloned() {
                        let mut plan = FixPlan {
                            description: "Inject Logic Level Shifter".to_string(),
                            added_components: Vec::new(),
                            added_wires: Vec::new(),
                            removed_wires: Vec::new(),
                            transformations: Vec::new(),
                            reasoning: vec!["Logic level mismatch detected.".to_string()],
                        };
                        let target_pin = if msg.contains("pin") { "SDA" } else { "SDA" };
                        let target_node = format!("{}:{}", comp_id, target_pin);
                        let mut old_wire = None;
                        for w in &self.wires {
                            if w.from == target_node || w.to == target_node {
                                old_wire = Some(w.clone());
                                break;
                            }
                        }
                        if let Some(w) = old_wire {
                            let other_end = if w.from == target_node { w.to.clone() } else { w.from.clone() };
                            let sh_id = format!("ls_{}", comp_id);
                            plan.removed_wires.push(JsWireShort { from: w.from, to: w.to });
                            plan.added_components.push(JsComponent {
                                id: sh_id.clone(), kind: "wokwi-logic-level-shifter".to_string(),
                                x: comp.x - 60.0, y: comp.y + 120.0, rotation: 0.0,
                            });
                            plan.added_wires.push(JsWire {
                                from: other_end, to: format!("{}:HV1", sh_id), color: "orange".to_string(),
                                path: None,
                            });
                            plan.added_wires.push(JsWire {
                                from: format!("{}:LV1", sh_id), to: target_node, color: "green".to_string(),
                                path: None,
                            });
                            self.plans.push(plan);
                            continue;
                        }
                    }
                 }
             }

             if msg.contains("floating") || msg.contains("unconnected") || rule == "validateLedFloatingPins" {
                 if let Some(comp_id) = vio.component_ids.get(0) {
                     if let Some(comp) = self.components.get(comp_id).cloned() {
                         if let Some(board) = self.find_board() {
                             let pin_to_fix = if comp.kind == "wokwi-led" && (msg.contains("cathode") || msg.contains("(k)")) { "K".to_string() } 
                                              else if comp.kind == "wokwi-led" && (msg.contains("anode") || msg.contains("(a)")) { "A".to_string() }
                                              else if comp.kind == "wokwi-led" { "A".to_string() } 
                                              else { "1".to_string() };
                             
                             // CRITICAL: Check if this pin is ALREADY connected to avoid redundant suggestions
                             let mut already_wired = false;
                             let target_node = format!("{}:{}", comp_id, pin_to_fix);
                             for w in &self.wires {
                                 if w.from == target_node || w.to == target_node {
                                     already_wired = true;
                                     break;
                                 }
                             }

                             if already_wired {
                                 continue; // Skip if already wired, validator might be lagging
                             }

                             let target_rail = if pin_to_fix == "K" { "GND" } else { "5V" };
                             let start_p = self.get_pin_pos(&comp, &pin_to_fix);
                             let end_p = self.get_pin_pos(&board, target_rail);
                             
                             self.plans.push(FixPlan {
                                 description: format!("Connect floating {} on {} to {} rail", pin_to_fix, comp_id, target_rail),
                                 added_components: Vec::new(),
                                 added_wires: vec![JsWire {
                                     from: format!("{}:{}", comp_id, pin_to_fix),
                                     to: format!("{}:{}", board.id, target_rail),
                                     color: if target_rail == "GND" { "black".to_string() } else { "red".to_string() },
                                     path: Some(self.find_path(start_p, end_p)),
                                 }],
                                 removed_wires: Vec::new(),
                                 transformations: Vec::new(),
                                 reasoning: vec![format!("Detected floating pin: {}", vio.message)],
                             });
                         }
                     }
                 }
             }
        }
    }

    fn find_board(&self) -> Option<Component> {
        for comp in self.components.values() {
            if comp.kind.contains("arduino") || comp.kind.contains("pico") || comp.kind.contains("esp32") {
                return Some(comp.clone());
            }
        }
        None
    }

    fn get_pin_pos(&self, comp: &Component, pin_name: &str) -> Point {
        let mut dx: f64 = 20.0;
        let mut dy: f64 = 20.0;

        if comp.kind == "wokwi-resistor" {
            dy = 16.0;
            if pin_name == "1" { dx = 0.0; }
            else if pin_name == "2" { dx = 70.0; }
        } else if comp.kind == "wokwi-led" {
            dy = 22.0;
            if pin_name == "A" { dx = 0.0; }
            else if pin_name == "K" { dx = 72.0; }
        } else if comp.kind.contains("arduino-uno") {
            let ups: f64 = 18.0;
            let start_y: f64 = 34.0;
            let ur_list = ["A0", "A1", "A2", "A3", "A4", "A5", "vin", "gnd_1", "gnd_2", "gnd_3", "5V", "3v3", "rst", "ioref", "GND.1", "GND.2", "GND.3", "GND"];
            
            let mut is_right = false;
            for (i, &name) in ur_list.iter().enumerate() {
                if pin_name == name {
                    is_right = true;
                    dy = start_y + (i as f64 * ups);
                    break;
                }
            }
            if is_right { dx = 148.0; }
            else {
                dx = 0.0;
                if let Ok(num) = pin_name.parse::<f64>() {
                    dy = start_y + (num * ups);
                }
            }
        }
        
        Point { x: comp.x + dx, y: comp.y + dy }
    }

    fn get_pin_pos_by_id(&self, node_id: &str) -> Point {
        let parts: Vec<&str> = node_id.split(':').collect();
        if parts.len() < 2 { return Point { x: 0.0, y: 0.0 }; }
        if let Some(comp) = self.components.get(parts[0]) {
            return self.get_pin_pos(comp, parts[1]);
        }
        Point { x: 0.0, y: 0.0 }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct GridPos {
    x: i32,
    y: i32,
}

impl GridPos {
    fn distance(&self, other: &GridPos) -> u32 {
        (self.x.abs_diff(other.x) + self.y.abs_diff(other.y)) as u32
    }
}

// Global state protected by a Mutex for WASM safety
static ENGINE: Lazy<Mutex<Engine>> = Lazy::new(|| Mutex::new(Engine::new()));

// --- FFI / JS Exports ---

#[wasm_bindgen]
pub fn reset() {
    let mut engine = ENGINE.lock().unwrap();
    engine.reset();
}

#[wasm_bindgen(js_name = ingestComponent)]
pub fn ingest_component(id: String, kind: String, x: f64, y: f64, rotation: f64) {
    let mut engine = ENGINE.lock().unwrap();
    engine.components.insert(id.clone(), Component { id, kind, x, y, rotation });
}

#[wasm_bindgen(js_name = ingestWire)]
pub fn ingest_wire(from: String, to: String, color: String) {
    let mut engine = ENGINE.lock().unwrap();
    engine.wires.push(Wire { from, to, color, path: Vec::new() });
}

#[wasm_bindgen(js_name = ingestViolation)]
pub fn ingest_violation(rule_id: String, message: String, component_ids_str: String, severity: String) {
    let mut engine = ENGINE.lock().unwrap();
    let component_ids = component_ids_str.split(',').map(|s| s.trim().to_string()).collect();
    engine.violations.push(Violation { rule_id, message, component_ids, severity });
}

#[wasm_bindgen(js_name = getFixPlanCount)]
pub fn get_fix_plan_count() -> usize {
    let mut engine = ENGINE.lock().unwrap();
    engine.analyze(); // Trigger analysis before counting
    engine.plans.len()
}

// Individual getters for legacy compatibility with the current worker logic
#[wasm_bindgen(js_name = getFixDescription)]
pub fn get_fix_description(index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(index).map(|p| p.description.clone()).unwrap_or_default()
}

#[wasm_bindgen(js_name = getFixAddedWireCount)]
pub fn get_fix_added_wire_count(index: usize) -> usize {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(index).map(|p| p.added_wires.len()).unwrap_or(0)
}

#[wasm_bindgen(js_name = getAddedWireFrom)]
pub fn get_added_wire_from(fix_index: usize, wire_index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.added_wires.get(wire_index))
        .map(|w| w.from.clone())
        .unwrap_or_default()
}

#[wasm_bindgen(js_name = getAddedWireTo)]
pub fn get_added_wire_to(fix_index: usize, wire_index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.added_wires.get(wire_index))
        .map(|w| w.to.clone())
        .unwrap_or_default()
}

#[wasm_bindgen(js_name = getFixAddedComponentCount)]
pub fn get_fix_added_component_count(index: usize) -> usize {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(index).map(|p| p.added_components.len()).unwrap_or(0)
}

#[wasm_bindgen(js_name = getAddedComponentId)]
pub fn get_added_component_id(fix_index: usize, comp_index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.added_components.get(comp_index))
        .map(|c| c.id.clone())
        .unwrap_or_default()
}

#[wasm_bindgen(js_name = getAddedComponentType)]
pub fn get_added_component_type(fix_index: usize, comp_index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.added_components.get(comp_index))
        .map(|c| c.kind.clone())
        .unwrap_or_default()
}

#[wasm_bindgen(js_name = getAddedComponentX)]
pub fn get_added_component_x(fix_index: usize, comp_index: usize) -> f64 {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.added_components.get(comp_index))
        .map(|c| c.x)
        .unwrap_or(0.0)
}

#[wasm_bindgen(js_name = getAddedComponentY)]
pub fn get_added_component_y(fix_index: usize, comp_index: usize) -> f64 {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.added_components.get(comp_index))
        .map(|c| c.y)
        .unwrap_or(0.0)
}

#[wasm_bindgen(js_name = getFixReasoningCount)]
pub fn get_fix_reasoning_count(index: usize) -> usize {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(index).map(|p| p.reasoning.len()).unwrap_or(0)
}

#[wasm_bindgen(js_name = getFixReasoningStep)]
pub fn get_fix_reasoning_step(fix_index: usize, step_index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.reasoning.get(step_index))
        .map(|s| s.clone())
        .unwrap_or_default()
}

#[wasm_bindgen(js_name = getFixTransformationCount)]
pub fn get_fix_transformation_count(index: usize) -> usize {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(index).map(|p| p.transformations.len()).unwrap_or(0)
}

#[wasm_bindgen(js_name = getTransformationComponentId)]
pub fn get_transformation_component_id(fix_index: usize, trans_index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.transformations.get(trans_index))
        .map(|t| t.component_id.clone())
        .unwrap_or_default()
}

#[wasm_bindgen(js_name = getTransformationRotation)]
pub fn get_transformation_rotation(fix_index: usize, trans_index: usize) -> f64 {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.transformations.get(trans_index))
        .map(|t| t.rotation)
        .unwrap_or(0.0)
}

#[wasm_bindgen(js_name = getFixRemovedWireCount)]
pub fn get_fix_removed_wire_count(index: usize) -> usize {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(index).map(|p| p.removed_wires.len()).unwrap_or(0)
}

#[wasm_bindgen(js_name = getRemovedWireFrom)]
pub fn get_removed_wire_from(fix_index: usize, wire_index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.removed_wires.get(wire_index))
        .map(|w| w.from.clone())
        .unwrap_or_default()
}

#[wasm_bindgen(js_name = getRemovedWireTo)]
pub fn get_removed_wire_to(fix_index: usize, wire_index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.removed_wires.get(wire_index))
        .map(|w| w.to.clone())
        .unwrap_or_default()
}

#[wasm_bindgen(js_name = getAddedWirePathPointCount)]
pub fn get_added_wire_path_point_count(fix_index: usize, wire_index: usize) -> usize {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.added_wires.get(wire_index))
        .and_then(|w| w.path.as_ref())
        .map(|path| path.len())
        .unwrap_or(0)
}

#[wasm_bindgen(js_name = getAddedWirePathPointX)]
pub fn get_added_wire_path_point_x(fix_index: usize, wire_index: usize, point_index: usize) -> f64 {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.added_wires.get(wire_index))
        .and_then(|w| w.path.as_ref())
        .and_then(|path| path.get(point_index))
        .map(|p| p.x)
        .unwrap_or(0.0)
}

#[wasm_bindgen(js_name = getAddedWirePathPointY)]
pub fn get_added_wire_path_point_y(fix_index: usize, wire_index: usize, point_index: usize) -> f64 {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(fix_index)
        .and_then(|p| p.added_wires.get(wire_index))
        .and_then(|w| w.path.as_ref())
        .and_then(|path| path.get(point_index))
        .map(|p| p.y)
        .unwrap_or(0.0)
}
