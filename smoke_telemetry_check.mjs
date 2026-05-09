#!/usr/bin/env node
import fs from 'fs';

function usage() {
  console.log('Usage: node smoke_telemetry_check.mjs <project-json> <diagnostic-report-json>');
  process.exit(2);
}

function readJson(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function detectBoardComponent(project) {
  const components = Array.isArray(project?.components) ? project.components : [];
  return components.find((component) => /(arduino|esp32|stm32|rp2040|pico)/i.test(String(component?.type || '')));
}

function getTelemetryEvents(report, key) {
  try {
    const parsed = JSON.parse(report?.[key] || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function eventType(event) {
  return Object.keys(event || {})[0] || 'Unknown';
}

function main() {
  const [projectFile, reportFile] = process.argv.slice(2);
  if (!projectFile || !reportFile) usage();

  const project = readJson(projectFile);
  const report = readJson(reportFile);

  const boardComponent = detectBoardComponent(project);
  const projectBoard = normalize(project?.board);
  const boardComponentType = normalize(boardComponent?.type);
  const boardMismatch = !!boardComponent && !!projectBoard && !projectBoard.includes('pico') && boardComponentType.includes('pico');

  const teacherEvents = getTelemetryEvents(report, 'teacher_telemetry');
  const studentEvents = getTelemetryEvents(report, 'student_telemetry');
  const allEvents = [...teacherEvents, ...studentEvents];
  const componentStateEvents = allEvents.filter((event) => eventType(event) === 'ComponentState');
  const lcdEvents = componentStateEvents.filter((event) => {
    const data = event.ComponentState || {};
    const id = normalize(data.id);
    return id.includes('lcd') || id.includes('oled') || id.includes('ssd1306');
  });

  const richTelemetryPresent = (Array.isArray(project?.components) ? project.components : []).some((component) => {
    const kind = normalize(component?.type);
    return [
      'lcd', 'oled', 'ssd1306', 'ili9341', 'nokia', 'max7219', 'tm1637',
      'servo', 'motor', 'stepper', 'hc-sr04', 'max30102', 'joystick', 'rotary',
      'potentiometer', 'soil', 'ldr', 'neopixel', 'buzzer', 'keypad', 'encoder',
    ].some((needle) => kind.includes(needle));
  });

  const behaviorScore = Number(report?.grading_report?.behavioral_score ?? report?.behavioral_score ?? 0);
  const looksSilent = richTelemetryPresent && componentStateEvents.length === 0;

  console.log('Board component:', boardComponent?.type || '(none)');
  console.log('Project board field:', project?.board || '(none)');
  console.log('Teacher events:', teacherEvents.length);
  console.log('Student events:', studentEvents.length);
  console.log('ComponentState events:', componentStateEvents.length);
  console.log('LCD/OLED events:', lcdEvents.length);
  console.log('Behavior score:', behaviorScore);

  const failures = [];
  if (boardMismatch) failures.push('Project board field conflicts with board component type.');
  if (looksSilent && behaviorScore >= 100) failures.push('Telemetry-rich project scored 100 with no ComponentState events.');
  if (richTelemetryPresent && lcdEvents.length === 0) failures.push('No LCD/OLED component telemetry found in report.');

  if (failures.length) {
    console.error('\nSmoke test FAILED');
    for (const failure of failures) console.error('- ' + failure);
    process.exit(1);
  }

  console.log('\nSmoke test PASSED');
}

main();
