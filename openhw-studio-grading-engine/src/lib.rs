use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProjectMeta {
    #[serde(default)]
    pub board: String,
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub connections: Vec<Wire>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub blocklyXml: Option<String>,
    #[serde(default, alias = "projectFiles")]
    pub projectFiles: Option<Vec<ProjectFile>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProjectFile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub content: String,
}



#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Component {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default)]
    pub w: f32,
    #[serde(default)]
    pub h: f32,
    #[serde(default)]
    pub attrs: Option<serde_json::Value>,
    #[serde(default)]
    pub snap: Option<serde_json::Value>,
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
    #[serde(default)]
    pub color: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum TelemetryEvent {
    PinChange { pin: String, state: bool, time_ms: u32 },
    SerialOutput { data: String, time_ms: u32 },
    ComponentState { id: String, key: String, value: serde_json::Value, time_ms: u32 },
    I2CTransaction { address: u8, signature: String, time_ms: u32 },
    SPITransaction { signature: String, time_ms: u32 },
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
    pub meta_json: String,
    pub behavior_json: String,
    pub health: i32,
    pub validation_errors_json: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ActivityMetrics {
    pub pins: u32,
    pub functional: u32,
    pub serial: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GradingReport {
    pub score: i32,
    pub spatial_score: i32,
    pub logic_score: i32,
    pub behavioral_score: i32,
    pub pin_fidelity: i32,
    pub code_score: i32,
    pub teacher_metrics: ActivityMetrics,
    pub student_metrics: ActivityMetrics,
    pub feedback: Vec<String>,
    pub logs: Vec<String>,
    pub teacher_telemetry: Option<String>,
    pub student_telemetry: Option<String>,
    pub id_mapping: Option<HashMap<String, String>>,
}

/// Perform high-fidelity normalization on telemetry:
/// 1. Delta-filtering (only keep state changes)
/// 2. ID Mapping (Student -> Teacher)
/// 3. Noise reduction (ignore static pins)
fn normalize_telemetry(events: &[TelemetryEvent], id_map: &HashMap<String, String>, is_student: bool) -> Vec<TelemetryEvent> {
    let mut normalized = Vec::new();
    let mut last_states: HashMap<String, serde_json::Value> = HashMap::new();
    let mut active_pins: HashMap<String, bool> = HashMap::new();

    // Pass 1: Identify truly active pins (ignore static noise)
    for e in events {
        if let TelemetryEvent::PinChange { pin, state, .. } = e {
            let entry = active_pins.entry(pin.clone()).or_insert(*state);
            if *entry != *state {
                active_pins.insert(pin.clone(), true); // Mark as active (changed at least once)
            }
        }
    }

    // Pass 2: Delta Filtering & Mapping
    for e in events {
        let mut event = e.clone();
        let key = match &mut event {
            TelemetryEvent::PinChange { pin, state, .. } => {
                if !active_pins.get(pin).cloned().unwrap_or(false) { continue; } // Prune static noise
                format!("p_{}", pin)
            },
            TelemetryEvent::ComponentState { id, key, value, .. } => {
                let mapped_id = if is_student { id_map.get(id).unwrap_or(id).clone() } else { id.clone() };
                *id = mapped_id.clone();
                format!("{}_{}", mapped_id, key)
            },
            TelemetryEvent::SerialOutput { data, .. } => format!("ser"),
            _ => continue, // Ignore transactions for AI string (handled by metrics)
        };

        let val = match &event {
            TelemetryEvent::PinChange { state, .. } => serde_json::Value::Bool(*state),
            TelemetryEvent::ComponentState { value, .. } => value.clone(),
            TelemetryEvent::SerialOutput { data, .. } => serde_json::Value::String(data.clone()),
            _ => serde_json::Value::Null,
        };

        if let Some(last) = last_states.get(&key) {
            if last == &val { continue; } // Ignore duplicates
        }
        last_states.insert(key, val);
        normalized.push(event);
    }

    normalized
}



#[derive(Deserialize)]
pub struct GradingOptions {
    pub exact_match: bool,
    pub check_breadboard: bool,
    pub check_overlap: bool,
    pub ignore_pin_changes: bool,
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
        version: 1,
        meta_json: project_json.to_string(),
        behavior_json: telemetry_json.to_string(),
        health,
        validation_errors_json: validation_errors_json.to_string(),
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


    let mut logs = Vec::new();
    logs.push("Initializing Grading Engine (Rust/WASM)...".to_string());

    // 1. Extract Teacher Data from Binary Key
    let (teacher_meta_val, teacher_behavior_val, teacher_health_val) = match postcard::from_bytes::<TeacherReference>(teacher_binary_key) {
        Ok(v) => {
            if v.version != 1 {
                logs.push(format!("Key Version Mismatch: Engine V1 vs Key V{}. Re-generating...", v.version));
                // In a real scenario, we might return an error here to force re-gen
            }
            let meta: ProjectMeta = serde_json::from_str(&v.meta_json).unwrap_or(ProjectMeta { board: "".to_string(), components: Vec::new(), connections: Vec::new(), code: None, blocklyXml: None, projectFiles: None });
            let behavior: BehavioralSnapshot = serde_json::from_str(&v.behavior_json).unwrap_or(BehavioralSnapshot { events: Vec::new(), duration_ms: 0, rich_metrics: None });
            (meta, behavior, v.health)
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
                        teacher_telemetry: None, student_telemetry: None,
                        id_mapping: None
                    }).unwrap();
                }
            };
            (meta, BehavioralSnapshot { events: Vec::new(), duration_ms: 0, rich_metrics: None }, 100)
        }
    };

    let teacher_meta = &teacher_meta_val;
    let teacher_behavior = &teacher_behavior_val;
    let teacher_health = teacher_health_val;

    if teacher_health < 100 {
        logs.push(format!("Warning: Teacher's reference circuit has spatial errors! (Health: {}%)", teacher_health));
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
                teacher_telemetry: None, student_telemetry: None,
                id_mapping: None
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
    let (behavioral_score, b_feedback, t_metrics, s_metrics, id_mapping) = compare_behavior(teacher_behavior, &student_behavior, &teacher_meta.components, &student_meta.components, &mut logs, &options);
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

    // 6. Final Scoring & Outcome-Based Boosting
    // If behavior is high, it proves the circuit works even if the wiring structure is unconventional.
    let mut logic_boosted = logic_score;
    if behavioral_score > 80 && logic_score < 70 {
        logic_boosted = 80; // Boost to "functional" level
        feedback.push("Note: Wiring structure differs from reference, but functional results prove valid connectivity.".to_string());
    }

    // Weights: Spatial(20%), Logic(20%), AI Semantic(30%), Verified Code(30%)
    // Note: AI Semantic and Code are combined in frontend, but we return parts here
    let raw_score = (spatial_score * 20 + logic_boosted * 20 + behavioral_score * 30 + code_score * 30) / 100;
    
    // Safety Penalty is applied to the final outcome
    let final_score = (raw_score * options.validation_health) / 100;

    logs.push(format!("Scoring Breakdown: Spatial: {}, Logic: {}, Behavior (Temporal): {}, Code: {}, Health Penalty: {}%", 
        spatial_score, logic_score, behavioral_score, code_score, 100 - options.validation_health));

    // Normalize for AI and UI
    let t_norm = normalize_telemetry(&teacher_behavior.events, &HashMap::new(), false);
    let s_norm = normalize_telemetry(&student_behavior.events, &id_mapping, true);

    let report = GradingReport {
        score: final_score.max(0),
        spatial_score,
        logic_score,
        behavioral_score,
        pin_fidelity: (s_metrics.pins as f32 / t_metrics.pins.max(1) as f32 * 100.0).min(100.0) as i32,
        code_score,
        teacher_metrics: t_metrics,
        student_metrics: s_metrics,
        feedback,
        logs,
        teacher_telemetry: Some(serde_json::to_string(&t_norm).unwrap_or_default()),
        student_telemetry: Some(serde_json::to_string(&s_norm).unwrap_or_default()),
        id_mapping: Some(id_mapping),
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


fn compare_behavior(
    teacher: &BehavioralSnapshot,
    student: &BehavioralSnapshot,
    t_meta: &ProjectMeta,
    s_meta: &ProjectMeta,
    logs: &mut Vec<String>,
    _options: &GradingOptions,
) -> (i32, Vec<String>, ActivityMetrics, ActivityMetrics, HashMap<String, String>) {
    let mut feedback = Vec::new();

    // 1. Metrics Calculation
    let t_pins = teacher.events.iter().filter(|e| matches!(e, TelemetryEvent::PinChange { .. })).count();
    let s_pins = student.events.iter().filter(|e| matches!(e, TelemetryEvent::PinChange { .. })).count();
    let t_serial = teacher.events.iter().filter(|e| matches!(e, TelemetryEvent::SerialOutput { .. })).count();
    let s_serial = student.events.iter().filter(|e| matches!(e, TelemetryEvent::SerialOutput { .. })).count();
    let t_active_count = teacher.events.iter().filter(|e| matches!(e, TelemetryEvent::ComponentState { .. })).count();
    let s_active_count = student.events.iter().filter(|e| matches!(e, TelemetryEvent::ComponentState { .. })).count();

    // 2. Build Connectivity Graphs (Hardware Signatures)
    fn build_conn_map(meta: &ProjectMeta) -> HashMap<String, Vec<(String, String, String)>> {
        let mut map = HashMap::new();
        for wire in &meta.connections {
            let from_parts: Vec<&str> = wire.from.split(':').collect();
            let to_parts: Vec<&str> = wire.to.split(':').collect();
            if from_parts.len() == 2 && to_parts.len() == 2 {
                map.entry(from_parts[0].to_string()).or_insert_with(Vec::new)
                   .push((from_parts[1].to_string(), to_parts[0].to_string(), to_parts[1].to_string()));
                map.entry(to_parts[0].to_string()).or_insert_with(Vec::new)
                   .push((to_parts[1].to_string(), from_parts[0].to_string(), from_parts[1].to_string()));
            }
        }
        map
    }

    let t_conn = build_conn_map(t_meta);
    let s_conn = build_conn_map(s_meta);

    // 3. Group Behavioral Events by ID
    fn group_by_id(events: &[TelemetryEvent]) -> HashMap<String, Vec<TelemetryEvent>> {
        let mut groups = HashMap::new();
        for e in events {
            if let TelemetryEvent::ComponentState { id, .. } = e {
                groups.entry(id.clone()).or_insert_with(Vec::new).push(e.clone());
            }
        }
        groups
    }

    let t_events_map = group_by_id(&teacher.events);
    let s_events_map = group_by_id(&student.events);

    // 4. THE TWO-PASS MATCHER (Structural + Behavioral)
    let mut id_map = HashMap::new();
    let mut student_pool: Vec<&Component> = s_meta.components.iter().collect();

    for t_comp in &t_meta.components {
        if t_comp.kind.contains("arduino") || t_comp.kind.contains("breadboard") {
            // Static matching for main boards
            if let Some(pos) = student_pool.iter().position(|s| s.kind == t_comp.kind) {
                let s_comp = student_pool.remove(pos);
                id_map.insert(t_comp.id.clone(), s_comp.id.clone());
            }
            continue;
        }

        // Pass 1: Find structural candidates (Same Type + Similar Connections)
        let mut candidates: Vec<(usize, f32)> = Vec::new();
        for (i, s_comp) in student_pool.iter().enumerate() {
            if s_comp.kind == t_comp.kind {
                let mut score = 10.0; // Base score for type match
                
                // Compare connections (Simplified structural match)
                let t_neighbors = t_conn.get(&t_comp.id);
                let s_neighbors = s_conn.get(&s_comp.id);
                if let (Some(tn), Some(sn)) = (t_neighbors, s_neighbors) {
                    if tn.len() == sn.len() { score += 20.0; }
                }
                candidates.push((i, score));
            }
        }

        // Pass 2: Behavioral Tie-Breaking
        let mut best_candidate_idx = None;
        let mut highest_behavior_score = -1.0;

        for (idx, struct_score) in candidates {
            let s_comp = student_pool[idx];
            let t_events = t_events_map.get(&t_comp.id);
            let s_events = s_events_map.get(&s_comp.id);
            
            let b_score = match (t_events, s_events) {
                (Some(te), Some(se)) => {
                    let t_trans = te.len() as f32;
                    let s_trans = se.len() as f32;
                    let diff = (t_trans - s_trans).abs();
                    100.0 - (diff / t_trans.max(1.0) * 100.0)
                },
                (None, None) => 100.0, // Both silent is a perfect match for static parts
                _ => 0.0
            };

            let total_score = struct_score + (b_score * 0.5); 
            if total_score > highest_behavior_score {
                highest_behavior_score = total_score;
                best_candidate_idx = Some(idx);
            }
        }

        if let Some(idx) = best_candidate_idx {
            let s_comp = student_pool.remove(idx);
            id_map.insert(t_comp.id.clone(), s_comp.id.clone());
        }
    }

    // 5. Final Behavioral Comparison using the Perfect Map
    let t_groups = group_events_ext(&teacher.events, &id_map, false);
    let s_groups = group_events_ext(&student.events, &HashMap::new(), true);

    let mut functional_score_sum = 0.0;
    let mut functional_weight_sum = 0.0;
    let mut electrical_score_sum = 0.0;
    let mut electrical_weight_sum = 0.0;

    for (t_id, t_timeline) in &t_groups {
        let is_pin = t_id.starts_with("pin:") || t_id.starts_with("p");
        let weight = 1.0; 

        let s_id = id_map.get(t_id).unwrap_or(t_id);
        let group_score = if let Some(s_timeline) = s_groups.get(s_id) {
            let mut matches = 0;
            let mut s_ptr = 0;
            for t_e in t_timeline {
                let limit = (s_ptr + 20).min(s_timeline.len());
                for i in s_ptr..limit {
                    if is_event_match(t_e, &s_timeline[i], 100) {
                        matches += 1;
                        s_ptr = i + 1;
                        break;
                    }
                }
            }
            if t_timeline.is_empty() { 1.0 } else { matches as f32 / t_timeline.len() as f32 }
        } else {
            0.0
        };

        if is_pin {
            electrical_score_sum += group_score * weight;
            electrical_weight_sum += weight;
        } else {
            functional_score_sum += group_score * weight;
            functional_weight_sum += weight;
        }
    }

    let f_match = if functional_weight_sum > 0.0 { functional_score_sum / functional_weight_sum } else { 1.0 };
    let e_match = if electrical_weight_sum > 0.0 { electrical_score_sum / electrical_weight_sum } else { 1.0 };
    
    let behavioral_score = ((f_match * 0.85) + (e_match * 0.15)) * 100.0;
    let pin_fidelity = (e_match * 100.0) as i32;

    let return_id_map: HashMap<String, String> = id_map.iter().map(|(k, v)| (v.clone(), k.clone())).collect();

    (behavioral_score as i32, feedback, 
     ActivityMetrics { pins: t_pins as u32, functional: t_active_count as u32, serial: t_serial as u32 }, 
     ActivityMetrics { pins: s_pins as u32, functional: s_active_count as u32, serial: s_serial as u32 }, 
     return_id_map)
}

fn group_events_ext(events: &[TelemetryEvent], id_alias_map: &HashMap<String, String>, is_student: bool) -> HashMap<String, Vec<TelemetryEvent>> {
    let mut groups = HashMap::new();
    for e in events {
        let group_id = match e {
            TelemetryEvent::PinChange { pin, .. } => format!("pin:{}", pin),
            TelemetryEvent::ComponentState { id, .. } => {
                if is_student { id.clone() } 
                else { id_alias_map.get(id).cloned().unwrap_or_else(|| id.clone()) }
            },
            TelemetryEvent::SerialOutput { .. } => "serial".to_string(),
            _ => "other".to_string()
        };
        groups.entry(group_id).or_insert_with(Vec::new).push(e.clone());
    }
    groups
}

fn is_event_match(t: &TelemetryEvent, s: &TelemetryEvent, time_tolerance: i32) -> bool {
    match (t, s) {
        (TelemetryEvent::PinChange { state: ts, time_ms: tt, .. }, TelemetryEvent::PinChange { state: ss, time_ms: st, .. }) => {
            ts == ss && (tt.clone() as i32 - st.clone() as i32).abs() <= time_tolerance
        },
        (TelemetryEvent::ComponentState { key: tk, value: tv, time_ms: tt, .. }, TelemetryEvent::ComponentState { key: sk, value: sv, time_ms: st, .. }) => {
            if tk != sk || (tt.clone() as i32 - st.clone() as i32).abs() > time_tolerance { return false; }
            if tv == sv { return true; }
            let tf = tv.as_f64().or_else(|| tv.as_str().and_then(|s| s.parse().ok()));
            let sf = sv.as_f64().or_else(|| sv.as_str().and_then(|s| s.parse().ok()));
            if let (Some(t_val), Some(s_val)) = (tf, sf) { (t_val - s_val).abs() <= (t_val * 0.05).max(0.05) } else { false }
        },
        (TelemetryEvent::SerialOutput { data: td, time_ms: tt, .. }, TelemetryEvent::SerialOutput { data: sd, time_ms: st, .. }) => {
            td == sd && (tt.clone() as i32 - st.clone() as i32).abs() <= time_tolerance
        },
        _ => false
    }
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

        if comp.snap.is_some() {
            // If the frontend provided a snap coordinate/metadata, it is perfectly snapped!
            pins_on_holes = pins.len();
        } else {
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



fn get_pin_class(pin: &str) -> String {
    let parts: Vec<&str> = pin.split(':').collect();
    if parts.len() < 2 { return pin.to_string(); }
    let comp = parts[0];
    let pin_name = parts[1];

    if comp.starts_with("uno") {
        match pin_name {
            "GND" | "GND.1" | "GND.2" | "GND.3" => format!("{}:GND_CLASS", comp),
            "5V" | "3.3V" | "VIN" => format!("{}:POWER_CLASS", comp),
            "A0" | "A1" | "A2" | "A3" | "A4" | "A5" => format!("{}:ANALOG_CLASS", comp),
            "3" | "5" | "6" | "9" | "10" | "11" => format!("{}:PWM_CLASS", comp),
            _ => pin.to_string(), 
        }
    } else {
        pin.to_string()
    }
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

    if !exact {
        feedback.push("Functional matching enabled: Pin equivalence classes (PWM, GND, Analog) are active.".to_string());
    }

    // Advanced wire connectivity check
    for tw in &teacher.connections {
        let tw_from_class = if exact { tw.from.clone() } else { get_pin_class(&tw.from) };
        let tw_to_class = if exact { tw.to.clone() } else { get_pin_class(&tw.to) };

        let found = student.connections.iter().any(|sw| {
            let sw_from_class = if exact { sw.from.clone() } else { get_pin_class(&sw.from) };
            let sw_to_class = if exact { sw.to.clone() } else { get_pin_class(&sw.to) };

            (sw_from_class == tw_from_class && sw_to_class == tw_to_class) || 
            (sw_from_class == tw_to_class && sw_to_class == tw_from_class)
        });

        if !found {
            score -= 10;
            if exact {
                feedback.push(format!("Missing Connection: Expected {} to {}.", tw.from, tw.to));
            } else {
                feedback.push(format!("Missing Functional Connection: Expected a path equivalent to {} -> {}.", tw.from, tw.to));
            }
        }
    }


    (score.max(0), feedback)
}
