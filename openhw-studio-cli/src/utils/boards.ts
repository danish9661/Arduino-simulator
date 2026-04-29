import type { BoardKind, ComponentEntry, OpenHwProject, ProjectFileEntry } from '../types.js';

export const BOARD_DEFAULT_BAUD: Record<BoardKind, number> = {
  arduino_uno: 9600,
  esp32: 115200,
  stm32: 115200,
  rp2040: 115200,
  unknown: 9600,
};

export const BOARD_FQBN: Record<BoardKind, string> = {
  arduino_uno: 'arduino:avr:uno',
  esp32: 'esp32:esp32:esp32',
  stm32: 'STMicroelectronics:stm32:GenF1',
  rp2040: 'rp2040:rp2040:rpipico',
  unknown: 'arduino:avr:uno',
};

export function normalizeBoardKind(source: string): BoardKind {
  const s = String(source || '').toLowerCase();
  if (s.includes('esp32')) return 'esp32';
  if (s.includes('stm32')) return 'stm32';
  if (s.includes('rp2040') || s.includes('pico')) return 'rp2040';
  if (s.includes('arduino') || s.includes('uno')) return 'arduino_uno';
  return 'unknown';
}

export function isProgrammableBoardType(type: string): boolean {
  return /(arduino|esp32|stm32|rp2040|pico)/i.test(String(type || ''));
}

export function resolveBoardFqbn(typeOrKind: string): string {
  const text = String(typeOrKind || '').toLowerCase();
  if (text.includes('pico-w') || text.includes('picow')) {
    return 'rp2040:rp2040:rpipicow';
  }
  const kind = normalizeBoardKind(text);
  return BOARD_FQBN[kind] || BOARD_FQBN.arduino_uno;
}

export function defaultBoardTypeForKind(kind: BoardKind): string {
  switch (kind) {
    case 'rp2040':
      return 'wokwi-raspberry-pi-pico';
    case 'esp32':
      return 'wokwi-esp32-devkit-v1';
    case 'stm32':
      return 'wokwi-stm32-blue-pill';
    case 'arduino_uno':
    default:
      return 'wokwi-arduino-uno';
  }
}

export function defaultMainFileName(kind: BoardKind, boardId: string): string {
  if (kind === 'rp2040') {
    return 'main.py';
  }
  return `${boardId}.ino`;
}

export function defaultMainCode(kind: BoardKind, boardId: string): string {
  if (kind === 'rp2040') {
    return `# ${boardId} MicroPython script\nfrom machine import Pin\nfrom time import sleep\n\nled = Pin('LED', Pin.OUT)\n\nwhile True:\n  led.toggle()\n  sleep(0.5)\n`;
  }

  if (kind === 'esp32' || kind === 'stm32') {
    return `// ${boardId} main sketch\nvoid setup() {\n  // Serial.begin(115200);\n}\n\nvoid loop() {\n  delay(1000);\n}\n`;
  }

  return `// ${boardId} main sketch\nvoid setup() {\n  pinMode(13, OUTPUT);\n  // Serial.begin(9600);\n}\n\nvoid loop() {\n  digitalWrite(13, HIGH);\n  delay(500);\n  digitalWrite(13, LOW);\n  delay(500);\n}\n`;
}

export function inferBoardFromComponents(components: ComponentEntry[]): string {
  const board = components.find((c) => isProgrammableBoardType(c.type));
  if (!board) return 'arduino_uno';
  const kind = normalizeBoardKind(board.type);
  return kind === 'unknown' ? 'arduino_uno' : kind;
}

export function getBoardComponents(project: OpenHwProject): ComponentEntry[] {
  return project.components.filter((c) => isProgrammableBoardType(c.type));
}

export function isFileDisabled(pathLike: string): boolean {
  return String(pathLike || '').toLowerCase().endsWith('.disabled');
}

export function getBoardFiles(project: OpenHwProject, boardId: string): ProjectFileEntry[] {
  return (project.projectFiles || [])
    .filter((f) => String(f.path || '').startsWith(`project/${boardId}/`))
    .filter((f) => !isFileDisabled(f.path));
}
