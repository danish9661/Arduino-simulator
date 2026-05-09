use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;

const FUNCTIONAL_WEIGHT: f32 = 0.85;
const ELECTRICAL_WEIGHT: f32 = 0.15;
const TIMELINE_TOLERANCE_MS: f32 = 250.0;
const TIMELINE_WINDOW: usize = 10;
const VERIFIED_CODE_WEIGHT: f32 = 0.70;
const PIN_FIDELITY_WEIGHT: f32 = 0.30;

fn normalize_id(id: &str) -> String {
    id.trim()
        .trim_start_matches("pin:")
        .trim_start_matches("p:")
        .trim_start_matches("pin_")
        .replace(' ', "")
        .to_lowercase()
}

fn is_telemetry_rich_component(kind: &str) -> bool {
    let normalized = normalize_id(kind);
    [
        "lcd",
        "oled",
        "ssd1306",
        "ili9341",
        "nokia",
        "max7219",
        "tm1637",
        "servo",
        "motor",
        "stepper",
        "hc-sr04",
        "max30102",
        "joystick",
        "rotary",
        "potentiometer",
        "soil",
        "ldr",
        "neopixel",
        "buzzer",
        "keypad",
        "encoder",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

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
    #[serde(default)]
    pub ignored_events: Vec<TelemetryEvent>,
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

/// Per-ID temporal match statistics used to build the Temporal Behavior UI table.
/// Groups events by ID (Pin X, Component Y) and compares index-by-index.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IdTemporalStats {
    pub id: String,
    pub id_type: String, // "pin" or "component"
    pub teacher_event_count: usize,
    pub student_event_count: usize,
    pub match_percentage: f32,
    pub matched_events: usize,
    pub is_silent_teacher: bool, // True if teacher has 0 events for this ID (grace = 100%)
    pub ignored_events: usize,
}

/// Temporal breakdown returned alongside behavioral_score.
/// Contains per-ID matching statistics and the time-normalized grouped events.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TemporalBreakdown {
    pub time_scale_factor: f32, // teacher_duration / student_duration for normalization
    pub id_stats: Vec<IdTemporalStats>,
    pub overall_temporal_score: i32, // Same as behavioral_score for now
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GradingReport {
    pub score: i32,
    pub spatial_score: i32,
    pub logic_score: i32,
    pub behavioral_score: i32,
    pub pin_fidelity: i32,
    pub code_score: i32,
    pub verified_code_score: i32,
    pub teacher_metrics: ActivityMetrics,
    pub student_metrics: ActivityMetrics,
    pub feedback: Vec<String>,
    pub logs: Vec<String>,
    pub teacher_telemetry: Option<String>,
    pub student_telemetry: Option<String>,
    pub id_mapping: Option<HashMap<String, String>>,
    pub temporal_breakdown: Option<TemporalBreakdown>,
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
            let normalized_pin = normalize_id(pin);
            let entry = active_pins.entry(normalized_pin).or_insert(*state);
            if *entry != *state {
                active_pins.insert(normalize_id(pin), true); // Mark as active (changed at least once)
            }
        }
    }

    // Pass 2: Delta Filtering & Mapping
    for e in events {
        let mut event = e.clone();
        let key = match &mut event {
            TelemetryEvent::PinChange { pin, state, .. } => {
                let normalized_pin = normalize_id(pin);
                if !active_pins.get(&normalized_pin).cloned().unwrap_or(false) { continue; } // Prune static noise
                *pin = normalized_pin.clone();
                format!("p_{}", normalized_pin)
            },
            TelemetryEvent::ComponentState { id, key, value, .. } => {
                let normalized_id = normalize_id(id);
                let mapped_id = if is_student { id_map.get(&normalized_id).cloned().unwrap_or(normalized_id.clone()) } else { normalized_id.clone() };
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
    #[serde(default = "default_simulation_speed")]
    pub simulation_speed: f32,
}

fn default_simulation_speed() -> f32 {
    1.0
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
            let behavior: BehavioralSnapshot = serde_json::from_str(&v.behavior_json).unwrap_or(BehavioralSnapshot { events: Vec::new(), duration_ms: 0, rich_metrics: None, ignored_events: Vec::new() });
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
                        pin_fidelity: 0,
                        code_score: 0,
                        verified_code_score: 0,
                        teacher_metrics: ActivityMetrics { pins: 0, functional: 0, serial: 0 },
                        student_metrics: ActivityMetrics { pins: 0, functional: 0, serial: 0 },
                        feedback, logs,
                        teacher_telemetry: None, student_telemetry: None,
                        id_mapping: None,
                        temporal_breakdown: None,
                    }).unwrap();
                }
            };
            (meta, BehavioralSnapshot { events: Vec::new(), duration_ms: 0, rich_metrics: None, ignored_events: Vec::new() }, 100)
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
                pin_fidelity: 0,
                code_score: 0,
                verified_code_score: 0,
                teacher_metrics: ActivityMetrics { pins: 0, functional: 0, serial: 0 },
                student_metrics: ActivityMetrics { pins: 0, functional: 0, serial: 0 },
                feedback, logs,
                teacher_telemetry: None, student_telemetry: None,
                id_mapping: None,
                temporal_breakdown: None,
            }).unwrap();
        }
    };

    let student_behavior: BehavioralSnapshot = serde_json::from_str(student_telemetry_json).unwrap_or(BehavioralSnapshot { events: Vec::new(), duration_ms: 0, rich_metrics: None, ignored_events: Vec::new() });

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
    let (behavioral_score, pin_fidelity_val, b_feedback, t_metrics, s_metrics, id_mapping, temporal_breakdown) = compare_behavior(teacher_behavior, &student_behavior, teacher_meta, &student_meta, &mut logs, &options);
    feedback.extend(b_feedback);
    
    // Extract diagnostic info from feedback (hacky but works for now to get it into logs)
    if let Some(diag) = feedback.iter().find(|f| f.contains("Diagnostic:")) {
        logs.push(diag.clone());
    }

    let student_serial: String = student_behavior.events.iter().filter_map(|e| if let TelemetryEvent::SerialOutput { data, .. } = e { Some(data.clone()) } else { None }).collect();
    
    logs.push(format!("Behavior: Telemetry diffing complete. Score: {}. (Captured {} student events vs {} teacher events, speed={}x)", behavioral_score, student_behavior.events.len(), teacher_behavior.events.len(), options.simulation_speed.max(1.0)));
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

    let verified_code_score_val = ((code_score as f32 * VERIFIED_CODE_WEIGHT) + (pin_fidelity_val as f32 * PIN_FIDELITY_WEIGHT)).round() as i32;

    let report = GradingReport {
        score: final_score.max(0),
        spatial_score,
        logic_score,
        behavioral_score,
        pin_fidelity: pin_fidelity_val,
        code_score,
        verified_code_score: verified_code_score_val,
        teacher_metrics: t_metrics,
        student_metrics: s_metrics,
        feedback,
        logs,
        teacher_telemetry: Some(serde_json::to_string(&t_norm).unwrap_or_default()),
        student_telemetry: Some(serde_json::to_string(&s_norm).unwrap_or_default()),
        id_mapping: Some(id_mapping),
        temporal_breakdown: Some(temporal_breakdown),
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


/// Compare behavior with Table-Aligned Temporal Fidelity:
/// 1. Group events by ID (Pin X, Component Y)
/// 2. For each group, compare events index-by-index (Event #1 ↔ Event #1, etc.)
/// 3. Silent-Pin Grace: if teacher has no events for a pin, mark as 100% match
/// 4. Time Normalization: scale student times to teacher clock
/// 5. Sliding Window: allow ±10 event window and ±250ms fuzzy match for startup noise
/// Returns: (behavioral_score, feedback, teacher_metrics, student_metrics, id_mapping, temporal_breakdown)
fn compare_behavior(
    teacher: &BehavioralSnapshot,
    student: &BehavioralSnapshot,
    t_meta: &ProjectMeta,
    s_meta: &ProjectMeta,
    logs: &mut Vec<String>,
    options: &GradingOptions,
) -> (i32, i32, Vec<String>, ActivityMetrics, ActivityMetrics, HashMap<String, String>, TemporalBreakdown) {
    let mut feedback = Vec::new();
    let mut temporal_stats = Vec::new();

    // 1. Metrics Calculation
    let t_pins = teacher.events.iter().filter(|e| matches!(e, TelemetryEvent::PinChange { .. })).count();
    let s_pins = student.events.iter().filter(|e| matches!(e, TelemetryEvent::PinChange { .. })).count();
    let t_serial = teacher.events.iter().filter(|e| matches!(e, TelemetryEvent::SerialOutput { .. })).count();
    let s_serial = student.events.iter().filter(|e| matches!(e, TelemetryEvent::SerialOutput { .. })).count();
    let t_active_count = teacher.events.iter().filter(|e| matches!(e, TelemetryEvent::ComponentState { .. })).count();
    let s_active_count = student.events.iter().filter(|e| matches!(e, TelemetryEvent::ComponentState { .. })).count();
    let telemetry_rich_components_present = t_meta.components.iter().chain(s_meta.components.iter()).any(|c| is_telemetry_rich_component(&c.kind));

    let mut t_unique_pins: HashMap<String, bool> = HashMap::new();
    let mut s_unique_pins: HashMap<String, bool> = HashMap::new();
    for e in &teacher.events {
        if let TelemetryEvent::PinChange { pin, .. } = e {
            t_unique_pins.insert(normalize_id(pin), true);
        }
    }
    for e in &student.events {
        if let TelemetryEvent::PinChange { pin, .. } = e {
            s_unique_pins.insert(normalize_id(pin), true);
        }
    }
    let teacher_pin_only_baseline = t_pins > 0 && t_pins <= t_unique_pins.len();
    let student_pin_only_baseline = s_pins > 0 && s_pins <= s_unique_pins.len();
    let no_functional_or_serial = t_active_count == 0 && s_active_count == 0 && t_serial == 0 && s_serial == 0;
    let empty_or_baseline_only = (teacher.events.is_empty() && student.events.is_empty())
        || (teacher_pin_only_baseline && student_pin_only_baseline);

    // 2. Build Connectivity Graphs (Hardware Signatures)
    fn build_conn_map(meta: &ProjectMeta) -> HashMap<String, Vec<(String, String, String)>> {
        let mut map = HashMap::new();
        for wire in &meta.connections {
            let from_parts: Vec<&str> = wire.from.split(':').collect();
            let to_parts: Vec<&str> = wire.to.split(':').collect();
            if from_parts.len() == 2 && to_parts.len() == 2 {
                let from_comp = normalize_id(from_parts[0]);
                let to_comp = normalize_id(to_parts[0]);
                map.entry(from_comp.clone()).or_insert_with(Vec::new)
                   .push((normalize_id(from_parts[1]), to_comp.clone(), normalize_id(to_parts[1])));
                map.entry(to_comp).or_insert_with(Vec::new)
                   .push((normalize_id(to_parts[1]), from_comp, normalize_id(from_parts[1])));
            }
        }
        map
    }

    let t_conn = build_conn_map(t_meta);
    let s_conn = build_conn_map(s_meta);

    // 3. THE TWO-PASS MATCHER (Structural + Behavioral)
    // Build a simple structural matcher: for each teacher component, find the best student component
    // based on type and pin connectivity. This produces an id_map: teacher_id -> student_id
    let mut id_map: HashMap<String, String> = HashMap::new();
    let mut student_pool: Vec<&Component> = s_meta.components.iter().collect();

    // Helper to extract pin identifiers from the connection map entries produced earlier
    let extract_pins = |conn_map: &HashMap<String, Vec<(String, String, String)>>, comp_id: &String| -> Vec<String> {
        let mut pins = Vec::new();
        if let Some(entries) = conn_map.get(&normalize_id(comp_id)) {
            for (pin, _other_comp, _other_pin) in entries {
                // normalize pin-like strings
                if pin.chars().all(|c| c.is_alphanumeric()) {
                    pins.push(pin.clone());
                }
            }
        }
        pins
    };

    for t_comp in &t_meta.components {
        if t_comp.kind.contains("arduino") || t_comp.kind.contains("breadboard") { continue; }

        let mut best_candidate_idx: Option<usize> = None;
        let mut highest_match_score: f32 = -1.0;

        let t_pins_vec = extract_pins(&t_conn, &t_comp.id);

        for (idx, s_comp) in student_pool.iter().enumerate() {
            if s_comp.kind != t_comp.kind { continue; }

            let mut match_score: f32 = 10.0; // base for type match

            let s_pins_vec = extract_pins(&s_conn, &s_comp.id);
            let pin_match = t_pins_vec.iter().any(|tp| s_pins_vec.contains(tp));

            if options.exact_match {
                if !pin_match && !t_pins_vec.is_empty() {
                    match_score = 0.0; // strict mode requires pin connectivity
                } else {
                    match_score += 50.0;
                }
            } else {
                if pin_match { match_score += 40.0; }
                else { match_score += 10.0; }
            }

            if match_score > highest_match_score && match_score > 0.0 {
                highest_match_score = match_score;
                best_candidate_idx = Some(idx);
            }
        }

        if let Some(idx) = best_candidate_idx {
            let s_comp = student_pool.remove(idx);
            id_map.insert(t_comp.id.clone(), s_comp.id.clone());
        }
    }

    // 4. TABLE-ALIGNED TEMPORAL FIDELITY MATCHER
    // Group events by ID and compare index-by-index with time normalization and sliding window
    let t_groups = group_events_ext(&teacher.events, &id_map, false);
    let s_groups = group_events_ext(&student.events, &HashMap::new(), true);

    // Time normalization factor
    let time_scale = if teacher.duration_ms > 0 && student.duration_ms > 0 {
        teacher.duration_ms as f32 / student.duration_ms as f32
    } else { 1.0 };

    let speed_factor = options.simulation_speed.max(1.0).min(8.0);
    // Fixed hard cap: 400ms tolerance for ALL speeds
    // Time drift > 400ms = points deducted (no exception based on speed)
    let adaptive_tolerance_ms = 400.0;  // FIXED: 400ms for 1x/2x/4x/8x
    logs.push(format!("Behavior: Temporal matcher configured with FIXED 400ms time drift tolerance (hard cap for all speeds).", ));

    let mut functional_score_sum = 0.0;
    let mut functional_weight_sum = 0.0;
    let mut electrical_score_sum = 0.0;
    let mut electrical_weight_sum = 0.0;

    // Build ignored-event groups so we can treat cutoff-only mismatches as ignored
    let t_ignored_groups = if teacher.ignored_events.is_empty() { HashMap::new() } else { group_events_ext(&teacher.ignored_events, &id_map, false) };
    let s_ignored_groups = if student.ignored_events.is_empty() { HashMap::new() } else { group_events_ext(&student.ignored_events, &HashMap::new(), true) };

    for (t_id, t_timeline) in &t_groups {
        let is_pin = t_id.starts_with("pin:") || t_id.starts_with("p") || t_id.starts_with("pinstate:");
        let weight = 1.0;

        // Extract component ID from t_id (handle pin: and pinstate: prefixes)
        let t_comp_id = if t_id.starts_with("pin:") {
            t_id.trim_start_matches("pin:").to_string()
        } else if t_id.starts_with("pinstate:") {
            t_id.trim_start_matches("pinstate:").split(':').next().unwrap_or("").to_string()
        } else {
            t_id.clone()
        };

        // Look up mapped student ID
        let s_comp_id = id_map.get(&t_comp_id).cloned().unwrap_or_else(|| t_comp_id.clone());
        
        // Reconstruct s_id with same prefix as t_id
        let s_id = if t_id.starts_with("pin:") {
            format!("pin:{}", s_comp_id)
        } else if t_id.starts_with("pinstate:") {
            let key_part = t_id.trim_start_matches("pinstate:").split(':').nth(1).unwrap_or("");
            format!("pinstate:{}:{}", s_comp_id, key_part)
        } else {
            s_comp_id.clone()
        };

        // SILENT-PIN GRACE: if teacher has 0 or 1 event (static/unchanged), mark as 100% match
        let is_silent_teacher = t_timeline.len() <= 1;
        
        let mut ignored_count = 0usize;
        let (group_score, matched_count) = if let Some(s_timeline) = s_groups.get(&s_id) {
            if is_silent_teacher {
                // Teacher pin is static/silent: student doesn't need to match anything
                (1.0_f32, t_timeline.len())
            } else {
                // INDEX-BY-INDEX MATCHING with sliding window fallback
                compare_events_indexed(t_timeline, s_timeline, time_scale, adaptive_tolerance_ms)
            }
        } else {
            if is_silent_teacher {
                // Teacher is silent, student has no events: perfect match
                (1.0_f32, 0)
            } else {
                // Teacher has events, student has none: check if student had only ignored events for this id
                if let Some(ignored) = s_ignored_groups.get(&s_id) {
                    ignored_count = ignored.len();
                    (1.0_f32, t_timeline.len())
                } else if let Some(last_event_time) = t_timeline.last().and_then(|e| Some(get_event_time(e) as i32)) {
                    // Grace events: if teacher's last event is near cutoff (>7700ms), treat as grace (no penalty)
                    if last_event_time > 7700 && last_event_time < 8000 {
                        // Teacher-only events near cutoff are treated as grace (forgivable)
                        (1.0_f32, t_timeline.len())
                    } else {
                        // Real mismatch (teacher events are well before cutoff)
                        (0.0_f32, 0)
                    }
                } else {
                    // Real mismatch
                    (0.0_f32, 0)
                }
            }
        };

        // Record temporal stats for UI rendering
        temporal_stats.push(IdTemporalStats {
            id: t_id.clone(),
            id_type: if is_pin { "pin".to_string() } else { "component".to_string() },
            teacher_event_count: t_timeline.len(),
            student_event_count: s_groups.get(&s_id).map(|v| v.len()).unwrap_or(0),
            match_percentage: (group_score * 100.0_f32).min(100.0_f32),
            matched_events: matched_count,
            is_silent_teacher,
            ignored_events: ignored_count,
        });

        if is_pin {
            electrical_score_sum += group_score * weight;
            electrical_weight_sum += weight;
        } else {
            functional_score_sum += group_score * weight;
            functional_weight_sum += weight;
        }
    }

    // Handle student-only groups (teacher missing) so we can optionally treat ignored teacher events as grace
    for (s_id, s_timeline) in &s_groups {
        if t_groups.contains_key(s_id) { continue; }

        let is_pin = s_id.starts_with("pin:") || s_id.starts_with("p") || s_id.starts_with("pinstate:");
        let mut ignored_count = 0usize;
        if let Some(t_ignored) = t_ignored_groups.get(s_id) {
            ignored_count = t_ignored.len();
        }

        let (group_score, matched_count) = if ignored_count > 0 {
            (1.0_f32, s_timeline.len())
        } else {
            (0.0_f32, 0)
        };

        temporal_stats.push(IdTemporalStats {
            id: s_id.clone(),
            id_type: if is_pin { "pin".to_string() } else { "component".to_string() },
            teacher_event_count: 0,
            student_event_count: s_timeline.len(),
            match_percentage: (group_score * 100.0).min(100.0_f32),
            matched_events: matched_count,
            is_silent_teacher: false,
            ignored_events: ignored_count,
        });
    }

    let f_match = if functional_weight_sum > 0.0 { functional_score_sum / functional_weight_sum } else { 1.0 };
    let e_match = if electrical_weight_sum > 0.0 { electrical_score_sum / electrical_weight_sum } else { 1.0 };
    
    let mut behavioral_score = f_match * 100.0;
    if no_functional_or_serial && empty_or_baseline_only {
        feedback.push("Behavior Warning: Insufficient runtime telemetry evidence (no serial/component activity; pin data was empty or baseline-only).".to_string());
        behavioral_score = behavioral_score.min(60.0);
    }
    if telemetry_rich_components_present && t_active_count == 0 && s_active_count == 0 && !teacher.events.is_empty() && !student.events.is_empty() {
        feedback.push("Behavior Warning: Telemetry-rich components were present, but no ComponentState events were captured. Check board selection and telemetry extraction.".to_string());
        behavioral_score = behavioral_score.min(80.0);
    }
    let pin_fidelity = (e_match * 100.0) as i32;

    let return_id_map: HashMap<String, String> = id_map.iter().map(|(k, v)| (v.clone(), k.clone())).collect();

    let temporal_breakdown = TemporalBreakdown {
        time_scale_factor: time_scale,
        id_stats: temporal_stats,
        overall_temporal_score: behavioral_score as i32,
    };

    (behavioral_score as i32, pin_fidelity, feedback,
     ActivityMetrics { pins: t_pins as u32, functional: t_active_count as u32, serial: t_serial as u32 }, 
     ActivityMetrics { pins: s_pins as u32, functional: s_active_count as u32, serial: s_serial as u32 }, 
     return_id_map,
     temporal_breakdown)
}

/// Compare two event timelines index-by-index with time normalization, sliding window, and fuzzy matching.
/// Returns (match_percentage: 0..1, matched_event_count).
fn compare_events_indexed(
    teacher_events: &[TelemetryEvent],
    student_events: &[TelemetryEvent],
    time_scale: f32,
    tolerance_ms: f32,
) -> (f32, usize) {
    #[derive(Default, Clone)]
    struct MatchRun {
        matched_count: usize,
        drifts_ms: Vec<f32>,
    }

    fn run_indexed_match(
        teacher_events: &[TelemetryEvent],
        student_events: &[TelemetryEvent],
        time_scale: f32,
        tolerance_ms: f32,
        phase_offset: usize,
    ) -> MatchRun {
        let mut matched_count = 0usize;
        let mut drifts_ms: Vec<f32> = Vec::new();
        let mut last_s_idx = phase_offset.min(student_events.len());

        for (t_idx, t_event) in teacher_events.iter().enumerate() {
            let t_time = get_event_time(t_event);

            let idx_aligned = t_idx + phase_offset;
            if idx_aligned < student_events.len() {
                let s_event = &student_events[idx_aligned];
                let s_time_norm = get_event_time(s_event) * time_scale;

                if is_event_match_fuzzy(t_event, s_event, t_time, s_time_norm, tolerance_ms) {
                    matched_count += 1;
                    drifts_ms.push(s_time_norm - t_time);
                    last_s_idx = idx_aligned + 1;
                    continue;
                }
            }

            let search_start = last_s_idx.min(student_events.len());
            let search_end = (last_s_idx + TIMELINE_WINDOW + 1).min(student_events.len());

            for s_idx in search_start..search_end {
                if s_idx == idx_aligned {
                    continue;
                }
                let s_event = &student_events[s_idx];
                let s_time_norm = get_event_time(s_event) * time_scale;

                if is_event_match_fuzzy(t_event, s_event, t_time, s_time_norm, tolerance_ms) {
                    matched_count += 1;
                    drifts_ms.push(s_time_norm - t_time);
                    last_s_idx = s_idx + 1;
                    break;
                }
            }
        }

        MatchRun { matched_count, drifts_ms }
    }

    if teacher_events.is_empty() {
        return (1.0, 0);
    }

    let mut best_run = run_indexed_match(teacher_events, student_events, time_scale, tolerance_ms, 0);

    // Phase-shift recovery for periodic signals (common at high speed) by trying small index offsets.
    let max_phase_offset = TIMELINE_WINDOW.min(student_events.len().saturating_sub(1));
    for phase_offset in 1..=max_phase_offset {
        let candidate = run_indexed_match(teacher_events, student_events, time_scale, tolerance_ms, phase_offset);
        if candidate.matched_count > best_run.matched_count {
            best_run = candidate;
        } else if candidate.matched_count == best_run.matched_count {
            let best_avg_abs = if best_run.drifts_ms.is_empty() {
                f32::INFINITY
            } else {
                best_run.drifts_ms.iter().map(|d| d.abs()).sum::<f32>() / best_run.drifts_ms.len() as f32
            };
            let cand_avg_abs = if candidate.drifts_ms.is_empty() {
                f32::INFINITY
            } else {
                candidate.drifts_ms.iter().map(|d| d.abs()).sum::<f32>() / candidate.drifts_ms.len() as f32
            };
            if cand_avg_abs < best_avg_abs {
                best_run = candidate;
            }
        }
    }

    let match_pct = best_run.matched_count as f32 / teacher_events.len() as f32;
    
    // Bonus for extra student events (indicates capture robustness): if student has more events than teacher,
    // allow up to 20% extra without penalty. More than 20% extra incurs a small penalty.
    let extra_events = (student_events.len() as i32 - teacher_events.len() as i32).max(0) as usize;
    let extra_tolerance = (teacher_events.len() as f32 * 0.20).ceil() as usize;
    
    let mut match_pct_adjusted = if extra_events <= extra_tolerance {
        match_pct // No penalty for reasonable extra events
    } else {
        let penalty = ((extra_events - extra_tolerance) as f32 / teacher_events.len() as f32).min(0.15);
        (match_pct - penalty).max(0.0)
    };

    // Drift-trend penalty: if matched pairs drift progressively in one direction,
    // apply a light deduction even when individual points still pass tolerance.
    if best_run.drifts_ms.len() >= 5 {
        let first = best_run.drifts_ms.first().copied().unwrap_or(0.0);
        let last = best_run.drifts_ms.last().copied().unwrap_or(0.0);
        let trend = last - first;
        let avg_abs = best_run.drifts_ms.iter().map(|d| d.abs()).sum::<f32>() / best_run.drifts_ms.len() as f32;

        if trend.abs() > 300.0 && avg_abs > 150.0 {
            let trend_penalty = ((trend.abs() - 300.0) / 1200.0).min(0.10);
            match_pct_adjusted = (match_pct_adjusted - trend_penalty).max(0.0);
        }
    }

    (match_pct_adjusted, best_run.matched_count)
}

/// Extract time_ms from a TelemetryEvent.
fn get_event_time(event: &TelemetryEvent) -> f32 {
    match event {
        TelemetryEvent::PinChange { time_ms, .. } => *time_ms as f32,
        TelemetryEvent::ComponentState { time_ms, .. } => *time_ms as f32,
        TelemetryEvent::SerialOutput { time_ms, .. } => *time_ms as f32,
        TelemetryEvent::I2CTransaction { time_ms, .. } => *time_ms as f32,
        TelemetryEvent::SPITransaction { time_ms, .. } => *time_ms as f32,
    }
}

fn get_connected_pins(id: &str, conn: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut pins = Vec::new();
    if let Some(neighbors) = conn.get(id) {
        for n in neighbors {
            // Check if neighbor is a pin like "uno1:13" or "13"
            if n.contains(":") {
                let parts: Vec<&str> = n.split(':').collect();
                if parts.len() > 1 && parts[1].chars().all(|c| c.is_alphanumeric()) {
                    pins.push(parts[1].to_string());
                }
            } else if n.chars().all(|c| c.is_digit(10)) {
                pins.push(n.clone());
            }
        }
    }
    pins
}

fn group_events_ext(events: &[TelemetryEvent], id_alias_map: &HashMap<String, String>, is_student: bool) -> HashMap<String, Vec<TelemetryEvent>> {
    let mut groups = HashMap::new();
    for e in events {
        let group_id = match e {
            TelemetryEvent::PinChange { pin, .. } => format!("pin:{}", normalize_id(pin)),
            TelemetryEvent::ComponentState { id, .. } => {
                let normalized_id = normalize_id(id);
                let key_norm = match e {
                    TelemetryEvent::ComponentState { key, .. } => normalize_id(key),
                    _ => String::new(),
                };
                let mapped_id = if is_student { normalized_id.clone() }
                else { id_alias_map.get(&normalized_id).cloned().unwrap_or_else(|| normalized_id.clone()) };
                let is_pin_like_state = key_norm.contains("analog") || key_norm.starts_with("pin") || key_norm.contains("gpio");
                if is_pin_like_state {
                    format!("pinstate:{}:{}", mapped_id, key_norm)
                } else {
                    mapped_id
                }
            },
            TelemetryEvent::SerialOutput { .. } => "serial".to_string(),
            _ => "other".to_string()
        };
        groups.entry(group_id).or_insert_with(Vec::new).push(e.clone());
    }
    groups
}

fn is_event_match_fuzzy(t: &TelemetryEvent, s: &TelemetryEvent, t_time: f32, s_time: f32, tolerance: f32) -> bool {
    if (t_time - s_time).abs() > tolerance { return false; }
    
    match (t, s) {
        (TelemetryEvent::PinChange { state: ts, .. }, TelemetryEvent::PinChange { state: ss, .. }) => {
            ts == ss
        },
        (TelemetryEvent::ComponentState { key: tk, value: tv, .. }, TelemetryEvent::ComponentState { key: sk, value: sv, .. }) => {
            if tk != sk { return false; }
            if tv == sv { return true; }
            let tf = tv.as_f64().or_else(|| tv.as_str().and_then(|s| s.parse().ok()));
            let sf = sv.as_f64().or_else(|| sv.as_str().and_then(|s| s.parse().ok()));
            if let (Some(t_val), Some(s_val)) = (tf, sf) { (t_val - s_val).abs() <= (t_val * 0.05).max(0.05) } else { false }
        },
        (TelemetryEvent::SerialOutput { data: td, .. }, TelemetryEvent::SerialOutput { data: sd, .. }) => {
            td.trim() == sd.trim()
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
