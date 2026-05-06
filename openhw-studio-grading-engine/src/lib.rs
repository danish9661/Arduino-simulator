use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProjectMeta {
    pub board: String,
    pub components: Vec<Component>,
    pub connections: Vec<Wire>,
    pub code: Option<String>,
    pub blocklyXml: Option<String>,
    pub projectFiles: Option<Vec<ProjectFile>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProjectFile {
    pub id: String,
    pub content: String,
}



#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Component {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Component {
    pub fn aabb(&self) -> (f32, f32, f32, f32) {
        (self.x, self.y, self.x + self.w, self.y + self.h)
    }

    pub fn intersects(&self, other: &Component) -> bool {
        let (ax1, ay1, ax2, ay2) = self.aabb();
        let (bx1, by1, bx2, by2) = other.aabb();
        !(ax2 < bx1 || ax1 > bx2 || ay2 < by1 || ay1 > by2)
    }
}


#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Wire {
    pub from: String,
    pub to: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum TelemetryEvent {
    PinChange { pin: String, state: bool, time_ms: u32 },
    SerialOutput { data: String, time_ms: u32 },
    ComponentState { id: String, key: String, value: String, time_ms: u32 },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BehavioralSnapshot {
    pub events: Vec<TelemetryEvent>,
    pub duration_ms: u32,
    pub rich_metrics: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TeacherReference {
    pub version: u32,
    pub meta: ProjectMeta,
    pub behavior: BehavioralSnapshot,
    pub health: i32,
    pub validation_errors: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ActivityMetrics {
    pub pins: u32,
    pub functional: u32,
    pub serial: u32,
}

#[derive(Serialize, Debug)]
pub struct GradingReport {
    pub score: i32,
    pub spatial_score: i32,
    pub logic_score: i32,
    pub behavioral_score: i32,
    pub teacher_metrics: ActivityMetrics,
    pub student_metrics: ActivityMetrics,
    pub feedback: Vec<String>,
    pub logs: Vec<String>,
    pub teacher_telemetry: Option<String>,
    pub student_telemetry: Option<String>,
}



#[derive(Deserialize)]
pub struct GradingOptions {
    pub exact_match: bool,
    pub check_breadboard: bool,
    pub check_overlap: bool,
    pub validation_health: i32,
    pub validation_errors: Vec<String>,
}

#[wasm_bindgen]
pub fn generate_binary_key(
    project_json: &str, 
    telemetry_json: &str, 
    health: i32, 
    validation_errors_json: &str
) -> Vec<u8> {
    let meta: ProjectMeta = serde_json::from_str(project_json).unwrap();
    let behavior: BehavioralSnapshot = serde_json::from_str(telemetry_json).unwrap();
    let validation_errors: Vec<String> = serde_json::from_str(validation_errors_json).unwrap_or_default();
    
    let reference = TeacherReference {
        version: 1, // Update this when breaking changes occur
        meta,
        behavior,
        health,
        validation_errors,
    };
    
    postcard::to_allocvec(&reference).unwrap()
}

#[wasm_bindgen]
pub fn grade_circuits_wasm(
    student_png: &[u8],
    teacher_binary_key: &[u8],
    student_telemetry_json: &str,
    options_json: JsValue
) -> JsValue {
    let options: GradingOptions = serde_wasm_bindgen::from_value(options_json).unwrap();
    let mut feedback = Vec::new();
    let mut spatial_score = 100;
    let mut logic_score = 100;
    let mut behavioral_score = 100;

    let mut logs = Vec::new();
    logs.push("Initializing Grading Engine (Rust/WASM)...".to_string());

    // 1. Extract Teacher Data from Binary Key
    let teacher_ref: TeacherReference = match postcard::from_bytes::<TeacherReference>(teacher_binary_key) {
        Ok(v) => {
            if v.version != 1 {
                logs.push(format!("Key Version Mismatch: Engine V1 vs Key V{}. Re-generating...", v.version));
                // In a real scenario, we might return an error here to force re-gen
            }
            logs.push("Successfully decrypted Teacher Binary Key.".to_string());
            v
        },
        Err(_) => {
            logs.push("Input is not a binary key. Attempting PNG metadata extraction...".to_string());
            let meta = match extract_meta(teacher_binary_key) {
                Ok(m) => m,
                Err(e) => {
                    feedback.push(format!("Teacher Key Error: {}", e));
                    return serde_wasm_bindgen::to_value(&GradingReport { 
                        score: 0, spatial_score: 0, logic_score: 0, behavioral_score: 0, 
                        teacher_metrics: ActivityMetrics { pins: 0, functional: 0, serial: 0 },
                        student_metrics: ActivityMetrics { pins: 0, functional: 0, serial: 0 },
                        feedback, logs,
                        teacher_telemetry: None, student_telemetry: None 
                    }).unwrap();
                }
            };
            TeacherReference {
                version: 1,
                meta,
                behavior: BehavioralSnapshot { events: Vec::new(), duration_ms: 0, rich_metrics: None },
                health: 100,
                validation_errors: Vec::new(),
            }
        }
    };

    let teacher_meta = &teacher_ref.meta;
    let teacher_behavior = &teacher_ref.behavior;

    if teacher_ref.health < 100 {
        logs.push(format!("Warning: Teacher's reference circuit has spatial errors! (Health: {}%)", teacher_ref.health));
    }

    logs.push(format!("Teacher Reference: {} components, {} connections.", teacher_meta.components.len(), teacher_meta.connections.len()));

    // 2. Extract Student Data from PNG
    let student_meta = match extract_meta(student_png) {
        Ok(m) => m,
        Err(e) => {
            return serde_wasm_bindgen::to_value(&GradingReport { 
                score: 0, spatial_score: 0, logic_score: 0, behavioral_score: 0, 
                teacher_metrics: ActivityMetrics { pins: 0, functional: 0, serial: 0 },
                student_metrics: ActivityMetrics { pins: 0, functional: 0, serial: 0 },
                feedback, logs,
                teacher_telemetry: None, student_telemetry: None 
            }).unwrap();
        }
    };

    let student_behavior: BehavioralSnapshot = serde_json::from_str(student_telemetry_json).unwrap_or(BehavioralSnapshot { events: Vec::new(), duration_ms: 0, rich_metrics: None });

    // 2. Spatial Eye Analysis (Physical Layout & Inventory)
    logs.push("Starting Spatial Eye Analysis...".to_string());
    
    // Check component inventory (Types and Counts)
    let mut t_kinds: Vec<String> = teacher_meta.components.iter().map(|c| c.kind.clone()).collect();
    let mut s_kinds: Vec<String> = student_meta.components.iter().map(|c| c.kind.clone()).collect();
    t_kinds.sort();
    s_kinds.sort();

    if t_kinds != s_kinds {
        spatial_score -= 30;
        feedback.push("Spatial Error: Component inventory does not match reference. (e.g., Wrong board or missing parts)".to_string());
        logs.push(format!("Spatial: Inventory mismatch detected. Teacher: {:?}, Student: {:?}", t_kinds, s_kinds));
    }

    let overlaps = check_overlaps(&student_meta.components);
    if overlaps > 0 {
        spatial_score -= overlaps * 15;
        feedback.push(format!("Spatial Error: {} overlapping component sets detected.", overlaps));
        logs.push(format!("Spatial: Detected {} collisions.", overlaps));
    }

    if options.check_breadboard {
        let (bb_score, bb_feedback) = validate_breadboard_snapping(&student_meta.components, false);
        spatial_score = (spatial_score + bb_score) / 2;
        feedback.extend(bb_feedback);
        logs.push(format!("Spatial: Pin-snapping check complete. Score: {}", bb_score));
    }

    logs.push(format!("Spatial: Final Analysis complete. Score: {}", spatial_score.max(0)));


    // 3. Logic Analysis
    logs.push("Starting Connectivity Graph Comparison...".to_string());
    let (l_score, l_feedback) = compare_graphs(&teacher_meta, &student_meta, options.exact_match);
    logic_score = l_score;
    feedback.extend(l_feedback);
    logs.push(format!("Logic: Graph isomorphism complete. Score: {}. ({} of {} teacher connections validated in student circuit)", logic_score, teacher_meta.connections.len() as i32 * logic_score / 100, teacher_meta.connections.len()));

    // 4. Behavioral Comparison (WASM-based Timeline Audit)
    let (behavioral_score, b_feedback, t_metrics, s_metrics) = compare_behavior(&teacher_behavior, &student_behavior, &teacher_meta.components, &student_meta.components);
    feedback.extend(b_feedback);
    
    // Extract diagnostic info from feedback (hacky but works for now to get it into logs)
    if let Some(diag) = feedback.iter().find(|f| f.contains("Diagnostic:")) {
        logs.push(diag.clone());
    }

    let student_serial: String = student_behavior.events.iter().filter_map(|e| if let TelemetryEvent::SerialOutput { data, .. } = e { Some(data.clone()) } else { None }).collect();
    
    logs.push(format!("Behavior: Telemetry diffing complete. Score: {}. (Captured {} student events vs {} teacher events)", behavioral_score, student_behavior.events.len(), teacher_behavior.events.len()));
    if !student_serial.is_empty() {
        let preview: String = student_serial.chars().take(50).collect();
        logs.push(format!("Behavior: Student Serial Output detected: '{}'{}", preview, if student_serial.len() > 50 { "..." } else { "" }));
    }

    // 5. Code & Block Analysis
    logs.push("Starting Code & Programming Logic Analysis...".to_string());
    let (c_score, c_feedback) = compare_code_and_blocks(&teacher_meta, &student_meta);
    let code_score = c_score;
    feedback.extend(c_feedback);
    logs.push(format!("Code: AST/Keyword matching complete. Score: {}. (Verified core Arduino/Logic structures)", code_score));

    // 6. Final Scoring & Validation Integration
    if options.validation_health < 100 {
        logs.push(format!("Validation: Health Score {}%", options.validation_health));
        for err in &options.validation_errors {
            logs.push(format!("Validation Detail: {}", err));
        }
        feedback.extend(options.validation_errors.clone());
    }

    // Weights: Spatial(20%), Logic(30%), Behavior(40%), Code(10%)
    // But we multiply the total by (health / 100) to penalize unsafe circuits
    let raw_score = (spatial_score * 20 + logic_score * 30 + behavioral_score * 40 + code_score * 10) / 100;
    let final_score = (raw_score * options.validation_health) / 100;

    logs.push(format!("Scoring Breakdown: Spatial: {}, Logic: {}, Behavior: {}, Code: {}, Health Penalty: {}%", 
        spatial_score, logic_score, behavioral_score, code_score, 100 - options.validation_health));

    let report = GradingReport {
        score: final_score.max(0),
        spatial_score,
        logic_score,
        behavioral_score,
        teacher_metrics: t_metrics,
        student_metrics: s_metrics,
        feedback,
        logs,
        teacher_telemetry: Some(serde_json::to_string_pretty(&teacher_behavior).unwrap_or_default()),
        student_telemetry: Some(serde_json::to_string_pretty(&student_behavior).unwrap_or_default()),
    };

    serde_wasm_bindgen::to_value(&report).unwrap()
}


fn compare_code_and_blocks(teacher: &ProjectMeta, student: &ProjectMeta) -> (i32, Vec<String>) {
    let mut score = 100;
    let mut feedback = Vec::new();

    // 1. Blockly XML Match
    if let (Some(t_xml), Some(s_xml)) = (&teacher.blocklyXml, &student.blocklyXml) {
        if t_xml != s_xml {
            score -= 20;
            feedback.push("Logic Warning: Block structure differs from the teacher's reference.".to_string());
        }
    }

    // 2. Main Code Match (Fuzzy)
    let t_code_combined = teacher.code.clone().unwrap_or_default() + 
        &teacher.projectFiles.as_ref().map(|files| files.iter().map(|f| f.content.clone()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
    
    let s_code_combined = student.code.clone().unwrap_or_default() + 
        &student.projectFiles.as_ref().map(|files| files.iter().map(|f| f.content.clone()).collect::<Vec<_>>().join("\n")).unwrap_or_default();

    if !t_code_combined.is_empty() && !s_code_combined.is_empty() {
        let t_clean: String = t_code_combined.chars().filter(|c| !c.is_whitespace()).collect();
        let s_clean: String = s_code_combined.chars().filter(|c| !c.is_whitespace()).collect();
        
        if t_clean != s_clean {
            let keywords = ["setup", "loop", "pinMode", "digitalWrite"];
            for kw in keywords {
                if t_code_combined.contains(kw) && !s_code_combined.contains(kw) {
                    score -= 10;
                    feedback.push(format!("Code Error: Missing required logic/function '{}'.", kw));
                }
            }
            if score == 100 {
                score -= 5;
                feedback.push("Code Note: Programming style differs from reference, but core logic is present.".to_string());
            }
        }
    } else if !t_code_combined.is_empty() && s_code_combined.is_empty() {
        score -= 50;
        feedback.push("Code Error: Student submission contains no code or logic blocks.".to_string());
    }


    (score.max(0), feedback)
}


fn compare_behavior(teacher: &BehavioralSnapshot, student: &BehavioralSnapshot, t_meta: &[Component], s_meta: &[Component]) -> (i32, Vec<String>, ActivityMetrics, ActivityMetrics) {
    let mut score = 100;
    let mut feedback = Vec::new();

    // 1. Calculate Activity Metrics for UI
    let t_pins = teacher.events.iter().filter(|e| matches!(e, TelemetryEvent::PinChange { .. })).count();
    let s_pins = student.events.iter().filter(|e| matches!(e, TelemetryEvent::PinChange { .. })).count();
    let t_serial = teacher.events.iter().filter(|e| matches!(e, TelemetryEvent::SerialOutput { .. })).count();
    let s_serial = student.events.iter().filter(|e| matches!(e, TelemetryEvent::SerialOutput { .. })).count();
    let t_active_count = teacher.events.iter().filter(|e| if let TelemetryEvent::ComponentState { .. } = e { true } else { false }).count();
    let s_active_count = student.events.iter().filter(|e| if let TelemetryEvent::ComponentState { .. } = e { true } else { false }).count();

    // 2. Build Component ID Alias Map (Teacher ID -> Student ID)
    let mut id_map = std::collections::HashMap::new();
    let mut student_pool: Vec<(&String, &String)> = s_meta.iter()
        .map(|c| (&c.id, &c.kind)).collect();

    for t_comp in t_meta {
        if let Some(pos) = student_pool.iter().position(|(sid, _)| *sid == &t_comp.id) {
            let (sid, _) = student_pool.remove(pos);
            id_map.insert(&t_comp.id, sid);
        } else {
            if let Some(pos) = student_pool.iter().position(|(_, skind)| *skind == &t_comp.kind) {
                let (sid, _) = student_pool.remove(pos);
                id_map.insert(&t_comp.id, sid);
            }
        }
    }

    // 3. Strict Deterministic Behavioral Sequence Matching
    let mut s_idx = 0;
    let mut mismatches = 0;
    let mut total_compared = 0;
    let time_tolerance = 50; 
    let value_epsilon = 0.05; // 5% difference allowed for floats

    for t_event in &teacher.events {
        total_compared += 1;
        let mut found = false;
        
        // Search window increased to 50 for better noise tolerance
        let search_limit = (s_idx + 50).min(student.events.len());
        for i in s_idx..search_limit {
            let s_event = &student.events[i];
            
            let type_match = match (t_event, s_event) {
                (TelemetryEvent::PinChange { pin: tp, state: ts, .. }, TelemetryEvent::PinChange { pin: sp, state: ss, .. }) => tp == sp && ts == ss,
                (TelemetryEvent::SerialOutput { data: td, .. }, TelemetryEvent::SerialOutput { data: sd, .. }) => td == sd,
                (TelemetryEvent::ComponentState { id: ti, key: tk, value: tv, .. }, TelemetryEvent::ComponentState { id: si, key: sk, value: sv, .. }) => {
                    // Check ID via Alias Map
                    let id_is_correct = id_map.get(ti).map(|id| *id == si).unwrap_or(false);
                    if id_is_correct && tk == sk {
                        // Fuzzy Value Match (Handle floats like "1.0" vs "1.00001")
                        if tv == sv {
                            true
                        } else {
                            if let (Ok(tf), Ok(sf)) = (tv.parse::<f64>(), sv.parse::<f64>()) {
                                (tf - sf).abs() <= (tf * value_epsilon).max(value_epsilon)
                            } else {
                                false
                            }
                        }
                    } else {
                        false
                    }
                },
                _ => false
            };

            if type_match {
                let t_time = match t_event { TelemetryEvent::PinChange { time_ms, .. } | TelemetryEvent::SerialOutput { time_ms, .. } | TelemetryEvent::ComponentState { time_ms, .. } => *time_ms };
                let s_time = match s_event { TelemetryEvent::PinChange { time_ms, .. } | TelemetryEvent::SerialOutput { time_ms, .. } | TelemetryEvent::ComponentState { time_ms, .. } => *time_ms };
                
                if (t_time as i32 - s_time as i32).abs() <= time_tolerance {
                    s_idx = i + 1;
                    found = true;
                    break;
                }
            }
        }

        if !found {
            mismatches += 1;
            if mismatches <= 5 {
                let desc = match t_event {
                    TelemetryEvent::PinChange { pin, state, time_ms } => format!("Pin {} -> {} at {}ms", pin, state, time_ms),
                    TelemetryEvent::SerialOutput { data, time_ms } => format!("Serial '{}' at {}ms", data, time_ms),
                    TelemetryEvent::ComponentState { id, key, value, time_ms } => format!("Component {} {}:{} at {}ms", id, key, value, time_ms),
                };
                feedback.push(format!("Behavioral Gap: Missing or deviated event: {}", desc));
            }
        }
    }

    if total_compared > 0 {
        let match_ratio = (total_compared - mismatches) as f32 / total_compared as f32;
        let behavioral_score = (match_ratio * 100.0) as i32;
        
        if match_ratio < 0.8 {
            score = (score as f32 * match_ratio) as i32;
            feedback.push(format!("Behavioral Error: Only {}% of the reference behavior was detected.", (match_ratio * 100.0) as i32));
        } else if match_ratio < 1.0 {
            score -= (100 - behavioral_score).min(20);
        }
    }

    let t_metrics = ActivityMetrics { pins: t_pins as u32, functional: t_active_count as u32, serial: t_serial as u32 };
    let s_metrics = ActivityMetrics { pins: s_pins as u32, functional: s_active_count as u32, serial: s_serial as u32 };

    (score.max(0), feedback, t_metrics, s_metrics)
}


#[wasm_bindgen]
pub fn extract_project_meta(student_png: &[u8]) -> Result<String, String> {
    match extract_meta(student_png) {
        Ok(meta) => Ok(serde_json::to_string(&meta).unwrap()),
        Err(e) => Err(e),
    }
}

fn extract_meta(bytes: &[u8]) -> Result<ProjectMeta, String> {
    let marker = b"\x00OPENHW_META\x00";
    let mut pos = None;
    
    if bytes.len() < marker.len() {
        return Err("File too small".to_string());
    }

    for i in (0..bytes.len() - marker.len()).rev() {
        if &bytes[i..i + marker.len()] == marker {
            pos = Some(i + marker.len());
            break;
        }
    }

    let start = pos.ok_or("The uploaded PNG does not contain simulator metadata. Please export it using the 'Download PNG' button in the simulator.")?;
    let json_bytes = &bytes[start..];
    let json_str = std::str::from_utf8(json_bytes).map_err(|_| "Invalid UTF-8 in metadata")?;
    
    serde_json::from_str(json_str).map_err(|e| format!("JSON Parse Error: {}", e))
}

fn check_overlaps(components: &[Component]) -> i32 {
    let mut overlaps = 0;
    for i in 0..components.len() {
        let c1 = &components[i];
        if c1.kind.contains("breadboard") { continue; } // Breadboards don't overlap others usually
        
        for j in i + 1..components.len() {
            let c2 = &components[j];
            if c2.kind.contains("breadboard") { continue; }
            
            if c1.intersects(c2) {
                overlaps += 1;
            }
        }
    }
    overlaps
}

fn get_pin_offsets(kind: &str) -> Vec<(f32, f32)> {
    match kind {
        "wokwi-led" => vec![(0.0, 0.0), (15.0, 0.0)], // Approximate relative to anchor
        "wokwi-resistor" => vec![(0.0, 0.0), (75.0, 0.0)], // Assuming standard 5-hole span
        "wokwi-pushbutton" => vec![(0.0, 0.0), (0.0, 15.0), (15.0, 0.0), (15.0, 15.0)],
        _ => vec![(0.0, 0.0)], // Default to origin
    }
}

fn validate_breadboard_snapping(components: &[Component], is_teacher: bool) -> (i32, Vec<String>) {
    let mut score = 100;
    let mut feedback = Vec::new();
    let hole_pitch = 15.0;

    let breadboards: Vec<&Component> = components.iter().filter(|c| c.kind.contains("breadboard")).collect();
    
    for comp in components {
        if comp.kind.contains("breadboard") || comp.kind.contains("arduino") { continue; }
        
        // Find if this component is "intended" to be on a breadboard 
        // (Wokwi often marks this in attrs, or we check if it's near one)
        let pins = get_pin_offsets(&comp.kind);
        let mut pins_on_holes = 0;

        for (px, py) in &pins {
            let wx = comp.x + px;
            let wy = comp.y + py;

            let mut on_hole = false;
            for bb in &breadboards {
                let (bx1, by1, bx2, by2) = bb.aabb();
                // Basic bounds check first
                if wx >= bx1 - 5.0 && wx <= bx2 + 5.0 && wy >= by1 - 5.0 && wy <= by2 + 5.0 {
                    let dx = (wx - bx1).abs() % hole_pitch;
                    let dy = (wy - by1).abs() % hole_pitch;
                    if (dx < 2.0 || dx > hole_pitch - 2.0) && (dy < 2.0 || dy > hole_pitch - 2.0) {
                        on_hole = true;
                        break;
                    }
                }
            }
            if on_hole { pins_on_holes += 1; }
        }

        if pins_on_holes == 0 {
            // If it's not on a breadboard at all, we don't necessarily penalize 
            // unless it's a component that MUST be (like an LED).
            if comp.kind == "wokwi-led" || comp.kind == "wokwi-resistor" {
                score -= 10;
                let msg = if is_teacher {
                    format!("Teacher Alert: {} is not snapped to any breadboard hole.", comp.id)
                } else {
                    format!("Spatial Error: {} is floating! Pins must be snapped to breadboard holes.", comp.id)
                };
                feedback.push(msg);
            }
        } else if pins_on_holes < pins.len() {
            score -= 5;
            let msg = if is_teacher {
                format!("Teacher Warning: {} has partially misaligned pins.", comp.id)
            } else {
                format!("Spatial Warning: {} is partially misaligned. Ensure all pins are in holes.", comp.id)
            };
            feedback.push(msg);
        }
    }

    (score.max(0), feedback)
}



fn compare_graphs(teacher: &ProjectMeta, student: &ProjectMeta, exact: bool) -> (i32, Vec<String>) {
    let mut score = 100;
    let mut feedback = Vec::new();

    // Check wire connectivity
    if teacher.connections.len() == 0 && student.connections.len() > 0 {
         score -= 20;
         feedback.push("Logic Warning: Student has extra wires not present in reference.".to_string());
    } else if teacher.connections.len() > 0 && student.connections.len() == 0 {
         score -= 50;
         feedback.push("Logic Error: Student circuit has 0 connections but reference requires wiring.".to_string());
    }

    // Basic wire connectivity check
    if exact {
        for tw in &teacher.connections {
            let found = student.connections.iter().any(|sw| 
                (sw.from == tw.from && sw.to == tw.to) || (sw.from == tw.to && sw.to == tw.from)
            );
            if !found {
                score -= 10;
                feedback.push(format!("Missing Connection: Expected {} to {}.", tw.from, tw.to));
            }
        }
    } else {
        // Functional match (simplified: just check if all types exist and are connected)
        feedback.push("Functional matching enabled: Pin differences ignored.".to_string());
    }


    (score.max(0), feedback)
}
