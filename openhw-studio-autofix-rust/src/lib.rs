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
    pub target_rule_id: String,
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

    pub fn fuzzy_get_component(&self, id: &str) -> Option<Component> {
        if let Some(c) = self.components.get(id) {
            return Some(c.clone());
        }
        let alt_id = if id.contains('_') { id.replace('_', "-") } else { id.replace('-', "_") };
        if let Some(c) = self.components.get(&alt_id) {
            return Some(c.clone());
        }
        None
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
                    
                    // Prevent infinite grid expansion capacity overflow
                    if next.x < -1000 || next.x > 3000 || next.y < -1000 || next.y > 3000 {
                        is_blocked = true;
                    } else if next != start && next != end {
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
                    if let Some(comp) = self.fuzzy_get_component(comp_id) {
                        self.plans.push(FixPlan {
                            description: format!("Flip polarity of {} to correct reverse bias", comp_id),
                            target_rule_id: rule.to_string(),
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
                    if let Some(comp) = self.fuzzy_get_component(&comp_id) {
                        let is_led = comp.kind.contains("led");
                        let target_pins = if is_led { vec!["A", "K"] } else { vec!["1", "2", "pos", "neg"] };
                        
                        let mut wires_to_replace = Vec::new();
                        let mut final_target_pin = "1";

                        for pin in target_pins {
                            let node_colon = format!("{}:{}", comp_id, pin);
                            let node_dot = format!("{}.{}", comp_id, pin);
                            for wire in &self.wires {
                                if wire.from == node_colon || wire.to == node_colon || wire.from == node_dot || wire.to == node_dot {
                                    wires_to_replace.push(wire.clone());
                                    final_target_pin = pin;
                                }
                            }
                            if !wires_to_replace.is_empty() { break; }
                        }

                        let res_id = format!("res_{}", comp_id);
                        let res_x = comp.x;
                        let res_y = comp.y - 60.0;
                        
                        let mut plan = FixPlan {
                            description: format!("Insert 220Ω protective resistor for {}", comp_id),
                            target_rule_id: rule.to_string(),
                            added_components: vec![JsComponent {
                                id: res_id.clone(),
                                kind: "openhw-resistor".to_string(),
                                x: res_x,
                                y: res_y,
                                rotation: 0.0,
                            }],
                            added_wires: Vec::new(),
                            removed_wires: Vec::new(),
                            transformations: Vec::new(),
                            reasoning: vec![
                                format!("Violation: Current limit exceeded on {}.", comp_id),
                                "Strategy: Injecting 220Ω current-limiting resistor.".to_string()
                            ],
                        };

                        if !wires_to_replace.is_empty() {
                            let target_node = format!("{}:{}", comp_id, final_target_pin);
                            plan.reasoning.push(format!("Intercepted {} existing wires on pin {}.", wires_to_replace.len(), final_target_pin));

                            for (i, old_wire) in wires_to_replace.iter().enumerate() {
                                plan.removed_wires.push(JsWireShort { from: old_wire.from.clone(), to: old_wire.to.clone() });
                                
                                // Only connect the FIRST wire's other end to the resistor input
                                // Subsequent redundant wires are simply removed to clean up the circuit
                                if i == 0 {
                                    let other_end = if old_wire.from == target_node || old_wire.from == target_node.replace(':', ".") { old_wire.to.clone() } else { old_wire.from.clone() };
                                    let start_p = self.get_pin_pos_by_id(&other_end);
                                    let mid_p1 = Point { x: res_x, y: res_y + 16.0 };
                                    plan.added_wires.push(JsWire {
                                        from: other_end,
                                        to: format!("{}:1", res_id),
                                        color: "red".to_string(),
                                        path: Some(self.find_path(start_p, mid_p1)),
                                    });
                                }
                            }

                            let mid_p2 = Point { x: res_x + 70.0, y: res_y + 16.0 };
                            let end_p = self.get_pin_pos(&comp, final_target_pin);
                            plan.added_wires.push(JsWire {
                                from: format!("{}:2", res_id),
                                to: target_node,
                                color: "red".to_string(),
                                path: Some(self.find_path(mid_p2, end_p)),
                            });
                        } else {
                            // Fallback: Just place the resistor and connect pin 2 to the component
                            plan.reasoning.push("Note: No direct wire found to intercept. Placing resistor nearby.".to_string());
                            let target_pin = if is_led { "A" } else { "1" };
                            let end_p = self.get_pin_pos(&comp, target_pin);
                            plan.added_wires.push(JsWire {
                                from: format!("{}:2", res_id),
                                to: format!("{}:{}", comp_id, target_pin),
                                color: "red".to_string(),
                                path: None,
                            });
                        }

                        self.plans.push(plan);
                        continue;
                    }
                 }
            }

            // --- Pattern 3: I2C Pull-up Infrastructure ---
            if rule == "validateI2CPullups" || msg.contains("sda missing pull-up") || msg.contains("scl missing pull-up") {
                if let Some(mcu_id) = vio.component_ids.get(0) {
                    if let Some(mcu) = self.components.get(mcu_id).cloned() {
                        let mut plan = FixPlan {
                            description: format!("Add 4.7kΩ I2C pull-up resistors for {}", mcu_id),
                            target_rule_id: rule.to_string(),
                            added_components: Vec::new(),
                            added_wires: Vec::new(),
                            removed_wires: Vec::new(),
                            transformations: Vec::new(),
                            reasoning: vec![format!("I2C lines on {} require pull-up resistors for stable communication.", mcu_id)],
                        };

                        let sda_pin = if mcu.kind.contains("pico") { "GP4" } else { "A4" };
                        let scl_pin = if mcu.kind.contains("pico") { "GP5" } else { "A5" };
                        let vcc_pin = if mcu.kind.contains("pico") { "3V3" } else { "5V" };

                        for (i, pin) in [sda_pin, scl_pin].iter().enumerate() {
                            let res_id = format!("pullup_{}_{}", mcu_id, i);
                            let res_x = mcu.x + 160.0 + (i as f64 * 80.0);
                            let res_y = mcu.y + 40.0;
                            
                            plan.added_components.push(JsComponent {
                                id: res_id.clone(),
                                kind: "openhw-resistor".to_string(),
                                x: res_x,
                                y: res_y,
                                rotation: 90.0,
                            });

                            let p_start = self.get_pin_pos(&mcu, pin);
                            let p_mid = Point { x: res_x + 16.0, y: res_y };
                            plan.added_wires.push(JsWire {
                                from: format!("{}:{}", mcu_id, pin),
                                to: format!("{}:1", res_id),
                                color: "green".to_string(),
                                path: Some(self.find_path(p_start, p_mid)),
                            });

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
                    if let Some(comp) = self.fuzzy_get_component(comp_id) {
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
                                target_rule_id: rule.to_string(),
                                added_components: Vec::new(),
                                added_wires: Vec::new(),
                                removed_wires: vec![JsWireShort { from: old_wire.from.clone(), to: old_wire.to.clone() }],
                                transformations: Vec::new(),
                                reasoning: vec![format!("Pin {} is 3.3V only. 5V signal detected. Injecting voltage divider.", target_pin)],
                            };

                            let other_end = if old_wire.from == target_node { old_wire.to.clone() } else { old_wire.from.clone() };
                            let r1_id = format!("vd1_{}", comp_id);
                            let r2_id = format!("vd2_{}", comp_id);
                            
                            plan.added_components.push(JsComponent {
                                id: r1_id.clone(), kind: "openhw-resistor".to_string(),
                                x: comp.x - 100.0, y: comp.y - 40.0, rotation: 0.0,
                            });
                            plan.added_components.push(JsComponent {
                                id: r2_id.clone(), kind: "openhw-resistor".to_string(),
                                x: comp.x - 100.0, y: comp.y + 40.0, rotation: 90.0,
                            });

                             plan.added_wires.push(JsWire {
                                 from: other_end.clone(), to: format!("{}:1", r1_id), color: "orange".to_string(),
                                 path: Some(self.find_path(self.get_pin_pos_by_id(&other_end), Point { x: comp.x - 100.0, y: comp.y - 40.0 + 16.0 })),
                             });
  
                             plan.added_wires.push(JsWire {
                                 from: format!("{}:2", r1_id), to: target_node.clone(), color: "green".to_string(),
                                 path: Some(self.find_path(Point { x: comp.x - 30.0, y: comp.y - 40.0 + 16.0 }, self.get_pin_pos(&comp, target_pin))),
                             });
  
                             plan.added_wires.push(JsWire {
                                 from: format!("{}:2", r1_id), to: format!("{}:1", r2_id), color: "green".to_string(),
                                 path: None,
                             });
  
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
                      target_rule_id: rule.to_string(),
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
                    if let Some(comp) = self.fuzzy_get_component(comp_id) {
                        let mut plan = FixPlan {
                            description: "Inject Logic Level Shifter".to_string(),
                            target_rule_id: rule.to_string(),
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
                                id: sh_id.clone(), kind: "openhw-logic-level-shifter".to_string(),
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

             if rule == "validateDuplicateI2CAddress" || msg.contains("duplicate i2c address") {
                 self.plans.push(FixPlan {
                     description: "Update I2C Address or Add Multiplexer".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Duplicate I2C address detected. Adjusting component properties or injecting multiplexer (TCA9548A).".to_string()],
                 });
             }

             if rule == "validatePowerDissipation" || msg.contains("power dissipation") {
                 self.plans.push(FixPlan {
                     description: "Add Heatsink or Power Regulation".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Component exceeds safe power dissipation limits.".to_string()],
                 });
             }

             if rule == "validateI2CDeviceWithoutMcu" || msg.contains("i2c device without mcu") {
                 self.plans.push(FixPlan {
                     description: "Remove orphaned I2C device or add MCU".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Standalone I2C device found without an MCU to control it.".to_string()],
                 });
             }

             if rule == "validateSerialPinConflict" || msg.contains("serial pin conflict") {
                 self.plans.push(FixPlan {
                     description: "Re-route UART pins to resolve conflict".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Multiple devices mapped to the same hardware serial pins.".to_string()],
                 });
             }

             if rule == "validateTotalPowerBudget" || msg.contains("total power budget") {
                 self.plans.push(FixPlan {
                     description: "Add external power supply".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Total current draw exceeds the board's regulator capacity.".to_string()],
                 });
             }

             if rule == "validateThermalLimits" || msg.contains("thermal limits") {
                 self.plans.push(FixPlan {
                     description: "Add active cooling or throttle power".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Simulated thermal limits exceeded.".to_string()],
                 });
             }

             if rule == "validateBatteryLife" || msg.contains("battery life") {
                 self.plans.push(FixPlan {
                     description: "Optimize power states or increase battery capacity".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Expected battery life is below minimum threshold for operation.".to_string()],
                 });
             }

             if rule == "validateVoltageDrops" || msg.contains("voltage drops") {
                 self.plans.push(FixPlan {
                     description: "Thicken traces, decrease wire length, or add decoupling capacitors".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Significant voltage drop detected across supply lines.".to_string()],
                 });
             }

             if rule == "validateDeadlocks" || msg.contains("deadlocks") {
                 self.plans.push(FixPlan {
                     description: "Adjust timing or interrupts to clear logic deadlocks".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Hardware state machine or interrupt deadlock detected.".to_string()],
                 });
             }

             if rule == "validateSignalIntegrity" || msg.contains("signal integrity") {
                 self.plans.push(FixPlan {
                     description: "Add termination resistors or routing shields".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["High frequency signal integrity issues identified (e.g. reflections/crosstalk).".to_string()],
                 });
             }

             if rule == "validateCrossComponentInteractions" || msg.contains("cross component") {
                 self.plans.push(FixPlan {
                     description: "Isolate interfering components".to_string(),
                     target_rule_id: rule.to_string(),
                     added_components: Vec::new(),
                     added_wires: Vec::new(),
                     removed_wires: Vec::new(),
                     transformations: Vec::new(),
                     reasoning: vec!["Adverse interactions detected between components (e.g. shared bus contention).".to_string()],
                 });
             }

             // --- Pattern 5: Duplicate Wire Removal ---
             for i in 0..self.wires.len() {
                 for j in (i + 1)..self.wires.len() {
                     let w1 = &self.wires[i];
                     let w2 = &self.wires[j];
                     if (w1.from == w2.from && w1.to == w2.to) || (w1.from == w2.to && w1.to == w2.from) {
                         self.plans.push(FixPlan {
                             description: format!("Remove duplicate wire between {} and {}", w1.from, w1.to),
                             target_rule_id: "cleanup".to_string(),
                             added_components: Vec::new(),
                             added_wires: Vec::new(),
                             removed_wires: vec![JsWireShort { from: w1.from.clone(), to: w1.to.clone() }],
                             transformations: Vec::new(),
                             reasoning: vec![format!("Redundant connection detected between {} and {}.", w1.from, w1.to)],
                         });
                         break;
                     }
                 }
             }

             if msg.contains("floating") || msg.contains("unconnected") || rule == "validateLedFloatingPins" {
                  if let Some(comp_id) = vio.component_ids.get(0) {
                      if let Some(comp) = self.fuzzy_get_component(comp_id) {
                          if let Some(board) = self.find_board() {
                               let msg_lc = msg.to_lowercase();
                               let is_led = comp.kind.contains("led");
                               let is_pot = comp.kind.contains("potentiometer");
                               let pin_to_fix = if is_led && (msg_lc.contains("cathode") || msg_lc.contains("(k)") || msg_lc.contains(" pin k")) { "K".to_string() } 
                                                else if is_led && (msg_lc.contains("anode") || msg_lc.contains("(a)") || msg_lc.contains(" pin a")) { "A".to_string() }
                                                else if is_pot && (msg_lc.contains("wiper") || msg_lc.contains("sig")) { "SIG".to_string() }
                                                else if is_pot && msg_lc.contains("pin 1") { "1".to_string() }
                                                else if is_pot && msg_lc.contains("pin 2") { "2".to_string() }
                                                else if is_led && !self.is_pin_occupied(&format!("{}:A", comp_id)) { "A".to_string() } 
                                                else if is_led && !self.is_pin_occupied(&format!("{}:K", comp_id)) { "K".to_string() }
                                                else { "1".to_string() };
                              
                              let mut target_pin = "GND".to_string();
                              if is_pot {
                                  let analog_pins = ["A0", "A1", "A2", "A3", "A4", "A5"];
                                  for p in analog_pins {
                                      let node = format!("{}:{}", board.id, p);
                                      if !self.is_pin_occupied(&node) {
                                          target_pin = p.to_string();
                                          break;
                                      }
                                  }
                              } else if comp.kind.contains("led") && pin_to_fix == "A" {
                                  target_pin = "5V".to_string();
                              }

                              let target_to_use = if comp.kind.contains("potentiometer") { target_pin.clone() } 
                                                   else if pin_to_fix == "K" { "GND".to_string() }
                                                   else { "5V".to_string() };

                               // PREVENT DUPLICATES: Only suggest if this specific connection doesn't exist
                               let from_node = format!("{}:{}", comp_id, pin_to_fix);
                               let to_node = format!("{}:{}", board.id, target_to_use);
                               let already_connected = self.wires.iter().any(|w| 
                                   (w.from == from_node && w.to == to_node) || (w.from == to_node && w.to == from_node)
                               );

                               if already_connected {
                                   continue;
                               }

                               let start_p = self.get_pin_pos(&comp, &pin_to_fix);
                               let end_p = self.get_pin_pos(&board, &target_to_use);
                               
                               self.plans.push(FixPlan {
                                   description: format!("Connect floating {} on {} to {}", pin_to_fix, comp_id, target_to_use),
                                   target_rule_id: rule.to_string(),
                                   added_components: Vec::new(),
                                   added_wires: vec![JsWire {
                                       from: from_node,
                                       to: to_node,
                                       color: if target_to_use == "GND" { "black".to_string() } else if target_to_use == "5V" { "red".to_string() } else { "#38bdf8".to_string() },
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

        // --- Post-Analysis Diagnostic ---
        if self.plans.is_empty() && !violations.is_empty() {
            let mut reasoning = vec![
                "⚠️ No repair strategy found for detected violations.".to_string(),
                format!("Diagnostic: Ingested {} components and {} wires.", self.components.len(), self.wires.len()),
            ];
            
            let comps_info: Vec<String> = self.components.values().map(|c| format!("{} ({})", c.id, c.kind)).collect();
            reasoning.push(format!("Seen Components: {}", comps_info.join(", ")));
            
            if let Some(vio) = violations.get(0) {
                reasoning.push(format!("Primary Violation: [{}] {}", vio.rule_id, vio.message));
                reasoning.push(format!("Targeted IDs: {:?}", vio.component_ids));
            }

            reasoning.push("Checked Patterns: Polarity, Resistor-Injection, Logic-Level, Floating-Pin, I2C-Infrastructure".to_string());

            self.plans.push(FixPlan {
                description: "🛠️ Engine Diagnostic Report".to_string(),
                target_rule_id: "diagnostic".to_string(),
                added_components: Vec::new(),
                added_wires: Vec::new(),
                removed_wires: Vec::new(),
                transformations: Vec::new(),
                reasoning,
            });
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

    fn is_pin_occupied(&self, node_id: &str) -> bool {
        self.wires.iter().any(|w| w.from == node_id || w.to == node_id)
    }

    fn get_pin_pos(&self, comp: &Component, pin_name: &str) -> Point {
        let mut dx: f64 = 20.0;
        let mut dy: f64 = 20.0;

        if comp.kind == "wokwi-resistor" || comp.kind == "openhw-resistor" {
            dy = 16.0;
            if pin_name == "1" { dx = 0.0; }
            else if pin_name == "2" { dx = 70.0; }
        } else if comp.kind == "wokwi-led" || comp.kind == "openhw-led" {
            dy = 22.0;
            if pin_name == "A" { dx = 0.0; }
            else if pin_name == "K" { dx = 72.0; }
        } else if comp.kind == "wokwi-potentiometer" || comp.kind == "openhw-potentiometer" {
            dy = 68.0;
            if pin_name == "1" { dx = 15.0; }
            else if pin_name == "SIG" { dx = 30.0; }
            else if pin_name == "2" { dx = 45.0; }
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

#[wasm_bindgen(js_name = getFixTargetRuleId)]
pub fn get_fix_target_rule_id(index: usize) -> String {
    let engine = ENGINE.lock().unwrap();
    engine.plans.get(index).map(|p| p.target_rule_id.clone()).unwrap_or_default()
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
        .cloned()
        .unwrap_or_default()
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
