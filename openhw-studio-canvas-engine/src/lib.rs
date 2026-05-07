use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use tiny_skia::*;
use usvg::TreeParsing;

macro_rules! log {
    ($($t:tt)*) => (web_sys::console::log_1(&format!($($t)*).into()))
}

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[derive(Deserialize)]
pub struct ProjectMeta {
    pub board: String,
    pub components: Vec<Component>,
    pub wires: Vec<Wire>,
}

#[derive(Deserialize)]
pub struct Component {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub rotate: Option<f32>,
    pub attrs: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct Wire {
    pub from: String,
    pub to: String,
    pub color: String,
    pub waypoints: Option<Vec<Point>>,
}

#[derive(Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

#[derive(Deserialize)]
pub struct RenderOptions {
    pub scale: f32,
    pub padding: f32,
    pub background: String,
}

#[wasm_bindgen]
pub fn render_circuit_wasm(
    project_json: &str,
    assets_json: &str,
    options_json: &str,
    full_metadata_json: &str
) -> Result<Vec<u8>, String> {
    let project: ProjectMeta = serde_json::from_str(project_json)
        .map_err(|e| format!("Project JSON error: {}", e))?;
    let assets: HashMap<String, String> = serde_json::from_str(assets_json)
        .map_err(|e| format!("Assets JSON error: {}", e))?;
    let options: RenderOptions = serde_json::from_str(options_json)
        .map_err(|e| format!("Options JSON error: {}", e))?;

    log!("[Canvas Engine] Rendering project: {} ({} components, {} assets)", 
         project.board, project.components.len(), assets.len());

    // 1. Calculate Bounds
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for c in &project.components {
        min_x = min_x.min(c.x);
        min_y = min_y.min(c.y);
        max_x = max_x.max(c.x + c.w);
        max_y = max_y.max(c.y + c.h);
    }

    for w in &project.wires {
        if let Some(wps) = &w.waypoints {
            for wp in wps {
                min_x = min_x.min(wp.x);
                min_y = min_y.min(wp.y);
                max_x = max_x.max(wp.x);
                max_y = max_y.max(wp.y);
            }
        }
    }

    if min_x.is_infinite() {
        log!("[Canvas Engine] Warning: No components found, using default bounds");
        min_x = 0.0; min_y = 0.0; max_x = 800.0; max_y = 600.0;
    }

    let pad = options.padding;
    min_x -= pad; min_y -= pad; max_x += pad; max_y += pad;

    let width = (max_x - min_x) * options.scale;
    let height = (max_y - min_y) * options.scale;

    log!("[Canvas Engine] Final Bounds: x={} y={} w={} h={} (Scale={})", 
         min_x, min_y, width, height, options.scale);

    let mut pixmap = Pixmap::new(width.max(1.0) as u32, height.max(1.0) as u32)
        .ok_or("Failed to create pixmap")?;

    // 2. Fill Background
    let bg_color = parse_hex_color(&options.background).unwrap_or(Color::from_rgba8(7, 11, 20, 255));
    pixmap.fill(bg_color);

    // 3. Render Components (First layer: Boards/Breadboards)
    render_layer(&mut pixmap, &project.components, &assets, &options, min_x, min_y, true)?;

    // 4. Render Wires
    render_wires(&mut pixmap, &project.wires, &options, min_x, min_y);

    // 5. Render Components (Second layer: Everything else)
    render_layer(&mut pixmap, &project.components, &assets, &options, min_x, min_y, false)?;

    // 6. Encode PNG
    let png_data = pixmap.encode_png()
        .map_err(|e| format!("PNG encoding error: {}", e))?;

    // 7. Append Metadata
    let marker = b"\x00OPENHW_META\x00";
    let mut combined = Vec::with_capacity(png_data.len() + marker.len() + full_metadata_json.len());
    combined.extend_from_slice(&png_data);
    combined.extend_from_slice(marker);
    combined.extend_from_slice(full_metadata_json.as_bytes());

    Ok(combined)
}

fn is_board(kind: &str) -> bool {
    let k = kind.to_lowercase();
    k.contains("board") || 
    k.contains("uno") || 
    k.contains("mega") || 
    k.contains("nano") || 
    k.contains("esp32") || 
    k.contains("raspberry") ||
    k.contains("pico")
}

fn render_layer(
    pixmap: &mut Pixmap,
    components: &[Component],
    assets: &HashMap<String, String>,
    options: &RenderOptions,
    off_x: f32,
    off_y: f32,
    is_board_layer: bool
) -> Result<(), String> {
    for comp in components {
        let board_flag = is_board(&comp.kind);
        if board_flag != is_board_layer { continue; }

        if let Some(svg_str) = assets.get(&comp.kind) {
            let tree = usvg::Tree::from_data(svg_str.as_bytes(), &usvg::Options::default())
                .map_err(|e| format!("SVG parse error for {}: {}", comp.kind, e))?;

            let mut pixmap_comp = Pixmap::new(
                (comp.w * options.scale).max(1.0) as u32,
                (comp.h * options.scale).max(1.0) as u32
            ).ok_or("Failed to create component pixmap")?;

            let r_ts = Transform::from_scale(
                (comp.w * options.scale) / tree.size.width(),
                (comp.h * options.scale) / tree.size.height()
            );

            resvg::render(&tree, r_ts, &mut pixmap_comp.as_mut());

            let rotate = comp.rotate.unwrap_or(0.0);
            let ts = Transform::from_translate(
                (comp.x - off_x) * options.scale,
                (comp.y - off_y) * options.scale,
            );
            
            let final_ts = if rotate != 0.0 {
                let cx = (comp.w * options.scale) / 2.0;
                let cy = (comp.h * options.scale) / 2.0;
                ts.pre_translate(cx, cy)
                  .pre_rotate(rotate)
                  .pre_translate(-cx, -cy)
            } else {
                ts
            };

            pixmap.draw_pixmap(
                0, 0,
                pixmap_comp.as_ref(),
                &PixmapPaint::default(),
                final_ts,
                None
            );
            
            log!("[Canvas Engine] Rendered {} at ({}, {})", comp.kind, comp.x, comp.y);
        } else {
            log!("[Canvas Engine] Missing asset for {}", comp.kind);
        }
    }
    Ok(())
}

fn render_wires(
    pixmap: &mut Pixmap,
    wires: &[Wire],
    options: &RenderOptions,
    off_x: f32,
    off_y: f32
) {
    let mut paint = Paint::default();
    paint.anti_alias = true;

    for wire in wires {
        let color = parse_hex_color(&wire.color).unwrap_or(Color::from_rgba8(0, 200, 0, 255));
        paint.set_color(color);

        if let Some(wps) = &wire.waypoints {
            if wps.len() < 2 { continue; }
            let mut pb = PathBuilder::new();
            for (i, wp) in wps.iter().enumerate() {
                let px = (wp.x - off_x) * options.scale;
                let py = (wp.y - off_y) * options.scale;
                if i == 0 { pb.move_to(px, py); }
                else { pb.line_to(px, py); }
            }
            if let Some(path) = pb.finish() {
                let stroke = Stroke {
                    width: 3.0 * options.scale,
                    ..Default::default()
                };
                pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
            }
        }
    }
}

fn parse_hex_color(hex: &str) -> Option<Color> {
    let hex = hex.trim_start_matches('#');
    if hex.len() == 6 {
        let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
        let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
        let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
        Some(Color::from_rgba8(r, g, b, 255))
    } else if hex.len() == 3 {
        let r = u8::from_str_radix(&hex[0..1], 16).ok()? * 17;
        let g = u8::from_str_radix(&hex[1..2], 16).ok()? * 17;
        let b = u8::from_str_radix(&hex[2..3], 16).ok()? * 17;
        Some(Color::from_rgba8(r, g, b, 255))
    } else {
        None
    }
}
