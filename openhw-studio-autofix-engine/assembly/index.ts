/**
 * Intelligent Autofix Engine (AssemblyScript/WASM)
 * Core logic for dependency-aware circuit repair.
 */

// Basic types for the engine
class Point {
  x: f64;
  y: f64;
}

class Component {
  id: string;
  type: string;
  x: f64;
  y: f64;
  w: f64;
  h: f64;
  rotation: f64;
  attrs: Map<string, string>;
  pins: string[];

  constructor(id: string, type: string, x: f64, y: f64, rotation: f64 = 0) {
    this.id = id;
    this.type = type;
    this.x = x;
    this.y = y;
    this.w = 40; // Default
    this.h = 40; // Default
    this.rotation = rotation;
    this.attrs = new Map<string, string>();
    this.pins = [];
  }
}

class Wire {
  from: string;
  to: string;
  color: string;
  path: Point[];

  constructor(from: string, to: string, color: string = "green") {
    this.from = from;
    this.to = to;
    this.color = color;
    this.path = [];
  }
}

class Violation {
  ruleId: string | null;
  message: string | null;
  componentIds: string[];
  severity: string | null;

  constructor(ruleId: string | null, message: string | null, componentIds: string[], severity: string | null) {
    this.ruleId = ruleId;
    this.message = message;
    this.componentIds = componentIds;
    this.severity = severity;
  }
}

class FixSuggestion {
  id: string;
  description: string;
  addedComponents: Component[];
  addedWires: Wire[];
  removedWires: string[];
  confidence: f64;
  dependencyId: string | null;
  transformations: Transformation[];
  reasoning: string[];

  constructor(id: string, description: string, confidence: f64) {
    this.id = id;
    this.description = description;
    this.addedComponents = [];
    this.addedWires = [];
    this.removedWires = [];
    this.transformations = [];
    this.confidence = confidence;
    this.dependencyId = null;
    this.reasoning = [];
  }
}

class Transformation {
  componentId: string;
  rotation: f64;

  constructor(componentId: string, rotation: f64) {
    this.componentId = componentId;
    this.rotation = rotation;
  }
}
class GridNode {
  x: i32;
  y: i32;
  g: f64;
  h: f64;
  f: f64;
  parent: GridNode | null;

  constructor(x: i32, y: i32) {
    this.x = x;
    this.y = y;
    this.g = 0;
    this.h = 0;
    this.f = 0;
    this.parent = null;
  }
}

class SpatialMap {
  grid: Uint8Array = new Uint8Array(0);
  width: i32;
  height: i32;
  cellSize: i32;

  constructor(w: i32, h: i32, cell: i32) {
    this.width = w / cell;
    this.height = h / cell;
    this.cellSize = cell;
    this.grid = new Uint8Array(this.width * this.height);
  }

  reset(): void {
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = 0;
  }

  markOccupied(x: f64, y: f64, w: f64, h: f64): void {
    const startX = <i32>(x / <f64>this.cellSize);
    const startY = <i32>(y / <f64>this.cellSize);
    const endX = <i32>((x + w) / <f64>this.cellSize);
    const endY = <i32>((y + h) / <f64>this.cellSize);

    for (let gy = startY; gy <= endY; gy++) {
      if (gy < 0 || gy >= this.height) continue;
      for (let gx = startX; gx <= endX; gx++) {
        if (gx < 0 || gx >= this.width) continue;
        this.grid[gy * this.width + gx] = 1;
      }
    }
  }

  isOccupied(gx: i32, gy: i32): bool {
    if (gx < 0 || gx >= this.width || gy < 0 || gy >= this.height) return true;
    return this.grid[gy * this.width + gx] == 1;
  }
}

// Memory-efficient graph for topological analysis
class CircuitGraph {
  components: Map<string, Component>;
  adjacencyList: Map<string, string[]>;
  wires: Wire[];

  constructor() {
    this.components = new Map<string, Component>();
    this.adjacencyList = new Map<string, string[]>();
    this.wires = [];
  }

  addComponent(comp: Component): void {
    this.components.set(comp.id, comp);
  }

  addWire(from: string, to: string, color: string = "green"): void {
    const wire = new Wire(from, to, color);
    this.wires.push(wire);

    if (!this.adjacencyList.has(from)) {
      this.adjacencyList.set(from, []);
    }
    const fromNeighbors = this.adjacencyList.get(from);
    if (fromNeighbors) fromNeighbors.push(to);

    if (!this.adjacencyList.has(to)) {
      this.adjacencyList.set(to, []);
    }
    const toNeighbors = this.adjacencyList.get(to);
    if (toNeighbors) toNeighbors.push(from);
  }

  getWiresConnectedTo(pinId: string): Wire[] {
    const result: Wire[] = [];
    for (let i = 0; i < this.wires.length; i++) {
      const w = this.wires[i];
      if (w.from == pinId || w.to == pinId) {
        result.push(w);
      }
    }
    return result;
  }

  // Find the "Power Source" node in a network
  findPowerSource(startNode: string): string | null {
    const visited = new Set<string>();
    const queue: string[] = [startNode];

    while (queue.length > 0) {
      const node = queue.shift();
      if (visited.has(node)) continue;
      visited.add(node);

      if (node.includes("VCC") || node.includes("5V") || node.includes("3V3")) {
        return node;
      }

      const neighbors = this.adjacencyList.get(node);
      if (neighbors) {
        for (let i = 0; i < neighbors!.length; i++) {
          queue.push(neighbors![i]);
        }
      }
    }
    return null;
  }
  isShortCircuit(nodeA: string, nodeB: string): bool {
    const isNodeAGnd = nodeA.toLowerCase().includes("gnd");
    const isNodeAVcc = nodeA.toLowerCase().includes("vcc") || nodeA.includes("5V") || nodeA.includes("3V3");
    
    const isNodeBGnd = nodeB.toLowerCase().includes("gnd");
    const isNodeBVcc = nodeB.toLowerCase().includes("vcc") || nodeB.includes("5V") || nodeB.includes("3V3");

    return (isNodeAGnd && isNodeBVcc) || (isNodeAVcc && isNodeBGnd);
  }

  findAvailablePin(componentId: string, requiredFamily: string): string | null {
    const comp = this.components.get(componentId);
    if (!comp) return null;

    const isUno = comp.type.includes("arduino-uno");
    const isPico = comp.type.includes("pico");

    if (isUno) {
      if (requiredFamily == "ANALOG" || requiredFamily == "ADC") {
        for (let i = 0; i <= 5; i++) {
          const pinName = "A" + i.toString();
          const nodeName = componentId + "." + pinName;
          const neighbors = this.adjacencyList.get(nodeName);
          if (!neighbors || neighbors.length === 0) return pinName;
        }
      } else {
        for (let i = 2; i <= 13; i++) {
          const pinName = i.toString();
          const nodeName = componentId + "." + pinName;
          const neighbors = this.adjacencyList.get(nodeName);
          if (!neighbors || neighbors.length === 0) {
            if (requiredFamily == "PWM" && ![3, 5, 6, 9, 10, 11].includes(i)) continue;
            return pinName;
          }
        }
      }
    } else if (isPico) {
      for (let i = 0; i <= 28; i++) {
        const pinName = "GP" + i.toString();
        const nodeName = componentId + "." + pinName;
        const neighbors = this.adjacencyList.get(nodeName);
        if (!neighbors || neighbors.length === 0) {
          if ((requiredFamily == "ANALOG" || requiredFamily == "ADC") && ![26, 27, 28].includes(i)) continue;
          return pinName;
        }
      }
    }
    return null;
  }
}

function getRulePriority(ruleId: string | null): i32 {
  if (!ruleId) return 10;
  const id = ruleId!;
  if (id.includes("power") || id.includes("ground") || id.includes("short-circuit")) return 100;
  if (ruleId.includes("connection") || ruleId.includes("unconnected")) return 50;
  return 10;
}

function getPinFamily(pinName: string): string {
  const lower = pinName ? pinName.toLowerCase() : "";
  if (lower.includes("gnd")) return "GROUND";
  if (lower.includes("vcc") || lower.includes("5v") || lower.includes("3v3") || lower.includes("vin")) return "POWER";
  if (lower.includes("sda") || lower.includes("scl")) return "I2C";
  if (lower.includes("mosi") || lower.includes("miso") || lower.includes("sck") || lower.includes("cs") || lower.includes("ss")) return "SPI";
  if (lower.includes("tx") || lower.includes("rx")) return "UART";
  if (lower.startsWith("a") && lower.length <= 2) return "ANALOG";
  if (lower.includes("adc")) return "ANALOG";
  if (lower.includes("pwm") || lower.includes("~")) return "PWM";
  return "DIGITAL";
}

class FixEngine {
  graph: CircuitGraph;
  violations: Violation[];
  spatialMap: SpatialMap;

  constructor() {
    this.graph = new CircuitGraph();
    this.violations = [];
    this.spatialMap = new SpatialMap(2000, 2000, 20);
    this.reset();
  }

  reset(): void {
    this.graph = new CircuitGraph();
    this.violations = [];
    this.spatialMap.reset();
    this.cachedPlan = null;
  }

  private updateSpatialMap(): void {
    this.spatialMap.reset();
    const keys = this.graph.components.keys();
    for (let i = 0; i < keys.length; i++) {
      const c = this.graph.components.get(keys[i]);
      if (c) {
        // Automatically fetch dimensions if not set
        const dim = this.getComponentDimensions(c.type);
        c.w = dim.x;
        c.h = dim.y;
        this.spatialMap.markOccupied(c.x, c.y, c.w, c.h);
      }
    }
  }

  private findPath(start: Point, end: Point): Point[] {
    const startGX = <i32>(start.x / <f64>this.spatialMap.cellSize);
    const startGY = <i32>(start.y / <f64>this.spatialMap.cellSize);
    const endGX = <i32>(end.x / <f64>this.spatialMap.cellSize);
    const endGY = <i32>(end.y / <f64>this.spatialMap.cellSize);

    const openList: GridNode[] = [];
    const closedSet = new Set<string>();

    const startNode = new GridNode(startGX, startGY);
    openList.push(startNode);

    let attempts = 0;
    while (openList.length > 0 && attempts < 500) {
      attempts++;
      // Get lowest F
      let bestIdx = 0;
      for (let i = 1; i < openList.length; i++) {
        if (openList[i].f < openList[bestIdx].f) bestIdx = i;
      }
      const current = openList[bestIdx];
      openList.splice(bestIdx, 1);

      if (current.x == endGX && current.y == endGY) {
        // Found path
        const path: Point[] = [];
        let curr: GridNode | null = current;
        while (curr) {
          const p = new Point();
          p.x = <f64>curr.x * <f64>this.spatialMap.cellSize + <f64>this.spatialMap.cellSize / 2.0;
          p.y = <f64>curr.y * <f64>this.spatialMap.cellSize + <f64>this.spatialMap.cellSize / 2.0;
          path.push(p);
          curr = curr.parent;
        }
        return path.reverse();
      }

      closedSet.add(current.x.toString() + "," + current.y.toString());

      const neighbors: i32[][] = [[0,1], [0,-1], [1,0], [-1,0]];
      for (let i = 0; i < neighbors.length; i++) {
        const nx = current.x + neighbors[i][0];
        const ny = current.y + neighbors[i][1];
        
        if (this.spatialMap.isOccupied(nx, ny)) continue;
        if (closedSet.has(nx.toString() + "," + ny.toString())) continue;

        const g = current.g + 1.0;
        const h = <f64>(Math.abs(nx - endGX) + Math.abs(ny - endGY));
        
        let foundInOpen = false;
        for (let j = 0; j < openList.length; j++) {
          if (openList[j].x == nx && openList[j].y == ny) {
            foundInOpen = true;
            if (g < openList[j].g) {
              openList[j].g = g;
              openList[j].f = g + h;
              openList[j].parent = current;
            }
            break;
          }
        }

        if (!foundInOpen) {
          const node = new GridNode(nx, ny);
          node.g = g;
          node.h = h;
          node.f = g + h;
          node.parent = current;
          openList.push(node);
        }
      }
    }

    return []; // No path found
  }

  private getPinPos(pinId: string): Point {
    const parts = pinId.split(".");
    const compId = parts[0];
    const pinName = parts.length > 1 ? parts[1] : "";
    
    const p = new Point();
    const comp = this.graph.components.get(compId);
    if (!comp) return p;

    // Default to component center
    const dim = this.getComponentDimensions(comp.type);
    let dx: f64 = dim.x / 2.0;
    let dy: f64 = dim.y / 2.0;

    // Specific pin offsets for known components
    if (comp.type == "wokwi-resistor") {
      dy = 16.0;
      if (pinName == "p1") dx = 0;
      else if (pinName == "p2") dx = 70.0;
    } else if (comp.type == "wokwi-led") {
      dy = 22.0;
      if (pinName == "A") dx = 0;
      else if (pinName == "K") dx = 72.0;
    } else if (comp.type == "wokwi-buzzer") {
      dy = 24.0;
      if (pinName == "1") dx = 0;
      else if (pinName == "2") dx = 52.0;
    } else if (comp.type.includes("arduino-uno")) {
      const UPS: f64 = 18.0;
      const startY: f64 = 34.0;
      const urList = ["A0", "A1", "A2", "A3", "A4", "A5", "vin", "gnd_1", "gnd_2", "gnd_3", "5V", "3v3", "rst", "ioref", "GND.1", "GND.2", "GND.3", "GND"];
      let isRight = false;
      for (let i = 0; i < urList.length; i++) {
        if (pinName == urList[i]) {
          isRight = true;
          dy = startY + (<f64>i * UPS);
          break;
        }
      }
      if (isRight) dx = 148.0;
      else {
        dx = 0.0;
        const pinNum = i32(parseInt(pinName));
        dy = startY + (<f64>pinNum * UPS);
      }
    } else if (comp.type.includes("pico")) {
      const UPS: f64 = 10.0;
      const startY: f64 = 20.0;
      const prList = ["VBUS", "VSYS", "GND.5", "3V3_EN", "3V3", "ADC_VREF", "GP28", "GND.6", "GP27", "GP26", "RUN", "GP22", "GND.7", "GP21", "GP20", "GP19", "GP18", "GND.8", "GP17", "GP16"];
      let isRight = false;
      for (let i = 0; i < prList.length; i++) {
        if (pinName == prList[i]) {
          isRight = true;
          dy = startY + (<f64>i * UPS);
          break;
        }
      }
      if (isRight) dx = 80.0;
      else dx = 0.0;
    }

    p.x = comp.x + dx;
    p.y = comp.y + dy;
    return p;
  }

  private getComponentDimensions(type: string): Point {
    const p = new Point();
    if (type == "wokwi-resistor") { p.x = 70; p.y = 32; }
    else if (type == "wokwi-led") { p.x = 72; p.y = 44; }
    else if (type == "wokwi-buzzer") { p.x = 52; p.y = 48; }
    else if (type == "wokwi-pushbutton") { p.x = 62; p.y = 48; }
    else if (type.includes("arduino-uno")) { p.x = 148; p.y = 298; }
    else if (type.includes("pico")) { p.x = 80; p.y = 210; }
    else { p.x = 50; p.y = 50; }
    return p;
  }

  private findSafePosition(startX: f64, startY: f64, w: f64, h: f64): Point {
    let x = startX;
    let y = startY;
    let attempts = 0;
    const maxAttempts = 50;
    const step = 20.0;

    while (attempts < maxAttempts) {
      let overlap = false;
      const keys = this.graph.components.keys();
      for (let i = 0; i < keys.length; i++) {
        const c = this.graph.components.get(keys[i]);
        if (c) {
          // AABB overlap check
          if (x < c.x + c.w && x + w > c.x && y < c.y + c.h && y + h > c.y) {
            overlap = true;
            break;
          }
        }
      }

      if (!overlap) break;
      
      // Simple spiral-ish shift
      if (attempts % 2 == 0) x += step;
      else y += step;
      
      attempts++;
    }

    const result = new Point();
    result.x = x;
    result.y = y;
    return result;
  }

  // Ingest data from JS
  ingestComponent(id: string | null, type: string | null, x: f64, y: f64, rotation: f64): void {
    if (!id || !type) return;
    const comp = new Component(id!, type!, x, y, rotation);
    this.graph.addComponent(comp);
  }

  ingestWire(from: string, to: string, color: string): void {
    this.graph.addWire(from, to);
  }

  ingestViolation(ruleId: string | null, message: string | null, componentIds: string | null, severity: string | null): void {
    const ids = componentIds && componentIds.length > 0 ? componentIds.split(',') : [];
    this.violations.push(new Violation(ruleId, message, ids, severity));
  }

  cachedPlan: FixSuggestion[] | null = null;

  // Semantic Pattern Matching & Dependency Planning
  generateFixPlan(): FixSuggestion[] {
    if (this.cachedPlan) return this.cachedPlan!;

    // Initialize "The Eye" - Spatial Mapping
    this.updateSpatialMap();

    const plan: FixSuggestion[] = [];
    
    // Sort violations by "Semantic Dependency"
    // Rule: Power foundation first, then logic, then conditioning.
    const sortedViolations = this.sortViolations(this.violations);

    for (let i = 0; i < sortedViolations.length; i++) {
      const violation = sortedViolations[i];
      if (!violation) continue;
      const fix = this.matchFixPattern(violation);
      if (fix) {
        plan.push(fix);
      }
    }

    this.cachedPlan = plan;
    return plan;
  }

  private sortViolations(violations: Violation[]): Violation[] {
    // Basic sorting logic: 'power' rules have higher priority
    return violations.sort((a, b) => {
      const aPrio = getRulePriority(a.ruleId);
      const bPrio = getRulePriority(b.ruleId);
      return bPrio - aPrio;
    });
  }

  private matchFixPattern(violation: Violation): FixSuggestion | null {
    // Semantic Matching Logic
    const ruleId = violation.ruleId || "";
    const message = violation.message || "";
    
    if (ruleId.includes("led-series-resistor") || ruleId.includes("led_resistor") || message.includes("No series resistance")) {
      return this.createLedResistorFix(violation);
    }
    
    if (ruleId.includes("buzzer-series-resistor")) {
      return this.createBuzzerResistorFix(violation);
    }

    if (ruleId.includes("i2c-pullups")) {
      return this.createI2CPullupFix(violation);
    }

    if (ruleId.includes("floating-pins")) {
      return this.createPullResistorFix(violation);
    }
    
    if (ruleId.includes("missing_ground")) {
      return this.createGroundFix(violation);
    }

    if (ruleId.includes("vcc-gnd-swap") || message.includes("VCC and GND are swapped")) {
      return this.createVccGndSwapFix(violation);
    }

    if (ruleId.includes("reverse-polarity") || ruleId.includes("diode-polarity") || ruleId.includes("ReversePolarity") || message.includes("Reverse breakdown")) {
      return this.createPolarityFlipFix(violation);
    }

    if (ruleId.includes("short-circuit") || ruleId.includes("rail-conflict")) {
      return this.createShortCircuitFix(violation);
    }

    if (ruleId.includes("signal-swap") || (violation.message && violation.message!.toLowerCase().includes("swap"))) {
      return this.createSignalSwapFix(violation);
    }

    if (ruleId.includes("logic-mismatch") || ruleId.includes("function-mismatch")) {
      return this.createFunctionMismatchFix(violation);
    }

    if (ruleId.includes("gpio-overload") || ruleId.includes("motor-drive")) {
      return this.createGpioOverloadFix(violation);
    }

    if (ruleId.includes("serial-pin-conflict")) {
      return this.createSerialRelocationFix(violation);
    }

    if (ruleId.includes("power-budget")) {
      return this.createExternalPowerFix(violation);
    }

    if (ruleId.includes("floating") || ruleId.includes("unconnected") || ruleId.includes("interface-check") || message.toLowerCase().includes("floating") || message.toLowerCase().includes("unconnected")) {
      return this.createInfrastructureFix(violation);
    }

    if (ruleId.includes("signal-integrity") || ruleId.includes("emi-risk")) {
      return this.createDecouplingFix(violation);
    }


    return null;
  }

  private findBoard(): Component | null {
    const keys = this.graph.components.keys();
    for (let i = 0; i < keys.length; i++) {
      const c = this.graph.components.get(keys[i]);
      if (!c) continue;
      const t = c!.type.toLowerCase();
      if (t.includes("arduino") || t.includes("pico") || t.includes("esp32") || t.includes("stm32") || t.includes("rp2040")) {
        return c;
      }
    }
    return null;
  }

  private createInfrastructureFix(violation: Violation): FixSuggestion | null {
    const fix = new FixSuggestion("infrastructure_fix", "Automatically connect missing Power/GND or Signal lines", 0.90);
    
    if (violation.componentIds.length > 0) {
      const compId = violation.componentIds[0];
      const comp = this.graph.components.get(compId);
      const msg = violation.message ? violation.message!.toLowerCase() : "";
      
      if (comp) {
        let isGnd = false;
        let color = "blue";

        if (msg.includes("cathode") || msg.includes("(k)") || msg.includes("gnd") || msg.includes("ground") || msg.includes("vss")) {
          isGnd = true;
          color = "black";
        } else if (msg.includes("anode") || msg.includes("(a)") || msg.includes("vcc") || msg.includes("power") || msg.includes("vdd")) {
          isGnd = false;
          color = "red";
        }

        const board = this.findBoard();
        if (board) {
          const boardId = board.id;
          const boardType = board.type.toLowerCase();
          const isPico = boardType.includes("pico");
          const isEsp32 = boardType.includes("esp32");
          
          let targetRail = "";
          if (isGnd) {
            targetRail = (isPico || !isEsp32) ? boardId + ".GND.1" : boardId + ".GND";
            if (isEsp32) targetRail = boardId + ".GND";
          } else {
            targetRail = isPico ? boardId + ".3V3" : boardId + ".5V";
            if (isEsp32) targetRail = boardId + ".3V3";
          }
          
          let compPin = compId + ".1";
          if (comp.type.includes("led")) {
            compPin = isGnd ? compId + ".K" : compId + ".A";
          } else if (comp.type.includes("resistor")) {
            compPin = isGnd ? compId + ".2" : compId + ".1";
          } else {
            // Try to extract pin from message like "(K)" or "(A)"
            if (msg.includes("(k)")) compPin = compId + ".K";
            else if (msg.includes("(a)")) compPin = compId + ".A";
            else if (msg.includes("(gnd)")) compPin = compId + ".GND";
            else if (msg.includes("(vcc)")) compPin = compId + ".VCC";
          }

          // Use pathfinding for the new wire
          const p1 = this.getPinPos(compPin);
          const p2 = this.getPinPos(targetRail);
          const path = this.findPath(p1, p2);
          
          const wire = new Wire(compPin, targetRail, color);
          wire.path = path;
          fix.addedWires.push(wire);
          
          fix.description = "Connect " + compId + " " + (isGnd ? "Cathode/GND" : "Anode/VCC") + " to " + (isGnd ? "Ground" : "Power");
          fix.reasoning.push("Detected floating terminal on " + compId + ".");
          fix.reasoning.push("Adding a direct " + color + " wire to " + targetRail + " to complete the circuit path.");
        }
      }
    }
    if (fix.addedWires.length > 0 || fix.addedComponents.length > 0 || fix.transformations.length > 0) {
      return fix;
    }
    return null;
  }

  private createDecouplingFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("decoupling_fix", "Add 0.1uF decoupling capacitor to filter signal noise", 0.88);
    const cap = new Component("fix_cap", "wokwi-capacitor", 0, 0);
    fix.addedComponents.push(cap);
    return fix;
  }


  private createGpioOverloadFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("gpio_overload_repair", "Insert MOSFET/Transistor driver to protect MCU GPIO", 0.96);
    if (violation.componentIds.length > 0) {
      const motorId = violation.componentIds[0];
      const motor = this.graph.components.get(motorId);
      if (motor) {
         const mosfet = new Component("fix_mosfet_" + motorId, "wokwi-npn-transistor", motor.x - 60, motor.y + 40);
         fix.addedComponents.push(mosfet);
         fix.description = "Add NPN Transistor to drive " + motorId;
      }
    }
    return fix;
  }

  private createSerialRelocationFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("serial_relocation", "Move connection away from Serial pins (D0/D1) to avoid upload conflicts", 0.92);
    if (violation.componentIds.length > 0) {
      const mcuId = violation.componentIds[0];
      const targetPin = this.graph.findAvailablePin(mcuId, "DIGITAL");
      if (targetPin) {
        fix.description = "Move connection to Pin D" + targetPin;
      }
    }
    return fix;
  }

  private createExternalPowerFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("external_power", "Add external 5V power supply to resolve power budget issues", 0.85);
    const supply = new Component("fix_power_supply", "wokwi-power-supply", 50, 50);
    fix.addedComponents.push(supply);
    return fix;
  }

  private createFunctionMismatchFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("function_mismatch_repair", "Move connection to a compatible pin (e.g., Analog to ADC pin)", 0.88);
    
    if (violation.componentIds.length > 0) {
      const targetCompId = violation.componentIds[0];
      const targetPinName = violation.message && violation.message!.includes(":") ? violation.message!.split(":").pop()!.trim() : "";
      
      // Find the board in the project
      let mcuId = "";
      const componentKeys = this.graph.components.keys();
      for (let i = 0; i < componentKeys.length; i++) {
          const c = this.graph.components.get(componentKeys[i]);
          if (c!.type.includes("arduino-uno") || c!.type.includes("pico")) {
              mcuId = componentKeys[i];
              break;
          }
      }

      if (mcuId != "") {
        // Determine required family
        let requiredFamily = "DIGITAL";
        if (violation.message && violation.message!.toLowerCase().includes("analog")) requiredFamily = "ANALOG";
        
        const newPin = this.graph.findAvailablePin(mcuId, requiredFamily);
        if (newPin) {
           // Find wire connected to the wrong pin
           const wrongPin = mcuId + "." + (targetPinName || "0");
           const ws = this.graph.getWiresConnectedTo(wrongPin);
           if (ws.length > 0) {
              const w = ws[0];
              const otherEnd = w.from == wrongPin ? w.to : w.from;
              
              fix.removedWires.push(w.from + "->" + w.to);
              fix.addedWires.push(new Wire(mcuId + "." + newPin, otherEnd, w.color));
              
              fix.description = "Move connection from " + wrongPin + " to " + mcuId + "." + newPin;
              fix.reasoning.push("Pin " + wrongPin + " does not support " + requiredFamily + " functions.");
              fix.reasoning.push("Relocated wire to " + mcuId + "." + newPin + " which is compatible.");
           }
        }
      }
    }
    return fix;
  }

  private createShortCircuitFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("short_circuit_repair", "Remove dangerous power-to-ground short circuit", 1.0);
    // Identify the offending wire and mark for removal
    if (violation.componentIds.length > 0) {
       // In a real implementation, we'd find the exact wire ID connecting these nodes
       fix.description = "Remove short circuit wire between " + (violation.message || "nodes");
    }
    return fix;
  }

  private createSignalSwapFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("signal_swap", "Correct crossed signal lines (e.g., TX/RX or SDA/SCL)", 0.94);
    
    if (violation.componentIds.length > 0) {
      const compId = violation.componentIds[0];
      const comp = this.graph.components.get(compId);
      if (comp) {
        // Common signal pairs to check for swaps
        const pairs: string[][] = [
          ["SDA", "SCL"],
          ["A4", "A5"],
          ["TX", "RX"],
          ["D0", "D1"],
          ["MOSI", "MISO"],
          ["D11", "D12"]
        ];

        let p1: string = "";
        let p2: string = "";
        let w1: Wire | null = null;
        let w2: Wire | null = null;

        for (let i = 0; i < pairs.length; i++) {
          const pair = pairs[i];
          const pinA = compId + "." + pair[0];
          const pinB = compId + "." + pair[1];
          
          const wsA = this.graph.getWiresConnectedTo(pinA);
          const wsB = this.graph.getWiresConnectedTo(pinB);

          if (wsA.length > 0 && wsB.length > 0) {
            p1 = pinA;
            p2 = pinB;
            w1 = wsA[0];
            w2 = wsB[0];
            break;
          }
        }

        if (w1 && w2) {
          const dest1 = w1!.from == p1 ? w1!.to : w1!.from;
          const dest2 = w2!.from == p2 ? w2!.to : w2!.from;

          fix.removedWires.push(w1!.from + "->" + w1!.to);
          fix.removedWires.push(w2!.from + "->" + w2!.to);

          fix.addedWires.push(new Wire(p1, dest2, w1!.color));
          fix.addedWires.push(new Wire(p2, dest1, w2!.color));

          fix.description = "Swap " + p1.split(".")[1] + " and " + p2.split(".")[1] + " for " + compId;
          fix.reasoning.push("Detected crossed signal lines for " + compId + ".");
          fix.reasoning.push("Swapped " + p1 + " and " + p2 + " connections to restore communication.");
        }
      }
    }
    return fix;
  }

  private createVccGndSwapFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("vcc_gnd_swap", "Swap Power (VCC) and Ground (GND) connections", 0.98);
    
    if (violation.componentIds.length > 0) {
      const compId = violation.componentIds[0];
      const comp = this.graph.components.get(compId);
      if (comp) {
        const pVccList: string[] = ["VCC", "5V", "VDD", "VIN"];
        const pGndList: string[] = ["GND", "VSS"];

        let pVcc: string = "";
        let pGnd: string = "";
        let wVcc: Wire | null = null;
        let wGnd: Wire | null = null;

        for (let i = 0; i < pVccList.length; i++) {
           const p = compId + "." + pVccList[i];
           const ws = this.graph.getWiresConnectedTo(p);
           if (ws.length > 0) {
               pVcc = p;
               wVcc = ws[0];
               break;
           }
        }

        for (let i = 0; i < pGndList.length; i++) {
           const p = compId + "." + pGndList[i];
           const ws = this.graph.getWiresConnectedTo(p);
           if (ws.length > 0) {
               pGnd = p;
               wGnd = ws[0];
               break;
           }
        }

        if (wVcc && wGnd) {
          const destVcc = wVcc!.from == pVcc ? wVcc!.to : wVcc!.from;
          const destGnd = wGnd!.from == pGnd ? wGnd!.to : wGnd!.from;

          fix.removedWires.push(wVcc!.from + "->" + wVcc!.to);
          fix.removedWires.push(wGnd!.from + "->" + wGnd!.to);

          fix.addedWires.push(new Wire(pVcc, destGnd, "red"));
          fix.addedWires.push(new Wire(pGnd, destVcc, "black"));

          fix.description = "Swap VCC and GND for " + compId;
          fix.reasoning.push("Detected that VCC and GND are swapped for " + compId + ".");
          fix.reasoning.push("Corrected wiring to prevent potential component damage.");
        }
      }
    }
    return fix;
  }

  private createLedResistorFix(violation: Violation): FixSuggestion | null {
    const fix = new FixSuggestion("led_series_resistor", "Add 220 Ohm series resistor to LED", 0.95);
    if (violation.componentIds.length > 0) {
      const ledId = violation.componentIds[0];
      const led = this.graph.components.get(ledId);
      if (led) {
        // Find current wire connected to Cathode (K)
        const cathodePin = ledId + ".K";
        
        // Prevent recursive repair if a repair resistor already exists
        if (this.graph.components.has("fix_res_" + ledId)) {
            return null;
        }

        const cathodeWires = this.graph.getWiresConnectedTo(cathodePin);
        
        let targetGnd = "GND";
        let originalWire: Wire | null = null;

        // Try to find a default board ground if nothing is connected
        const componentKeys = this.graph.components.keys();
        for (let i = 0; i < componentKeys.length; i++) {
            const c = this.graph.components.get(componentKeys[i]);
            if (c!.type.includes("arduino-uno")) {
                targetGnd = componentKeys[i] + ".gnd_1";
                break;
            } else if (c!.type.includes("pico")) {
                targetGnd = componentKeys[i] + ".GND";
                break;
            }
        }
        
        if (cathodeWires.length > 0) {
            originalWire = cathodeWires[0];
            targetGnd = originalWire!.from == cathodePin ? originalWire!.to : originalWire!.from;
            
            // Safety: If targetGnd is already a resistor pin or similar, avoid creating a loop
            if (targetGnd.includes("fix_res_")) {
                return null;
            }

            fix.removedWires.push(originalWire!.from + "->" + originalWire!.to);
        }

        // Create a resistor near the LED, but avoid overlap
        const dim = this.getComponentDimensions("wokwi-resistor");
        const pos = this.findSafePosition(led.x + 80, led.y, dim.x, dim.y);
        const res = new Component("fix_res_" + ledId, "wokwi-resistor", pos.x, pos.y);
        res.w = dim.x;
        res.h = dim.y;
        res.attrs.set("value", "220");
        fix.addedComponents.push(res);

        // Update spatial map with the new component so pathfinder sees it as an obstacle
        this.spatialMap.markOccupied(res.x, res.y, res.w, res.h);
        this.graph.components.set(res.id, res); // Also add to graph so getPinPos works
        
        // Logical rewiring with pathfinding
        const w1 = new Wire(cathodePin, res.id + ".p1", "black");
        w1.path = this.findPath(this.getPinPos(cathodePin), this.getPinPos(res.id + ".p1"));
        fix.addedWires.push(w1);

        const w2 = new Wire(res.id + ".p2", targetGnd, originalWire ? originalWire!.color : "black");
        w2.path = this.findPath(this.getPinPos(res.id + ".p2"), this.getPinPos(targetGnd));
        fix.addedWires.push(w2);

        fix.reasoning.push("Identified LED " + ledId + " without series resistance.");
        fix.reasoning.push("Calculated standard 220 Ohm current-limiting requirement.");
        fix.reasoning.push("Splitting Cathode net to insert protection resistor.");
      }
    }
    return fix;
  }

  private createBuzzerResistorFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("buzzer_series_resistor", "Add 220 Ohm series resistor to Buzzer", 0.92);
    if (violation.componentIds.length > 0) {
      const buzId = violation.componentIds[0];
      const buz = this.graph.components.get(buzId);
      if (buz) {
        // Find current wire connected to pin 1
        const buzPin = buzId + ".1";
        const buzWires = this.graph.getWiresConnectedTo(buzPin);
        
        let targetPin = "uno1.13"; // Default fallback
        let originalWire: Wire | null = null;
        
        if (buzWires.length > 0) {
            originalWire = buzWires[0];
            targetPin = originalWire!.from == buzPin ? originalWire!.to : originalWire!.from;
            fix.removedWires.push(originalWire!.from + "->" + originalWire!.to);
        }

        const dim = this.getComponentDimensions("wokwi-resistor");
        const pos = this.findSafePosition(buz.x - 80, buz.y, dim.x, dim.y);
        const res = new Component("fix_res_" + buzId, "wokwi-resistor", pos.x, pos.y);
        res.w = dim.x;
        res.h = dim.y;
        res.attrs.set("value", "220");
        fix.addedComponents.push(res);
        
        fix.addedWires.push(new Wire(buzPin, res.id + ".p1", "black"));
        fix.addedWires.push(new Wire(res.id + ".p2", targetPin, originalWire ? originalWire!.color : "black"));

        fix.reasoning.push("Detected Buzzer " + buzId + " connected directly to GPIO.");
        fix.reasoning.push("Pin current exceeds safe MCU limits (20mA).");
        fix.reasoning.push("Inserted 220 Ohm resistor between " + buzPin + " and " + targetPin + ".");
      }
    }
    return fix;
  }

  private createI2CPullupFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("i2c_pullups", "Add 4.7k I2C pull-up resistors", 0.96);
    
    let mcuId = "uno1";
    let targetVcc = "uno1.5V";
    
    const componentKeys = this.graph.components.keys();
    for (let i = 0; i < componentKeys.length; i++) {
        const c = this.graph.components.get(componentKeys[i]);
        if (c!.type.includes("arduino-uno")) {
            mcuId = componentKeys[i];
            targetVcc = mcuId + ".5V";
            break;
        }
    }

    const dim = this.getComponentDimensions("wokwi-resistor");
    const posSda = this.findSafePosition(100, 100, dim.x, dim.y);
    const resSda = new Component("fix_pull_sda", "wokwi-resistor", posSda.x, posSda.y);
    resSda.w = dim.x; resSda.h = dim.y;
    resSda.attrs.set("value", "4700");
    
    const posScl = this.findSafePosition(100, 140, dim.x, dim.y);
    const resScl = new Component("fix_pull_scl", "wokwi-resistor", posScl.x, posScl.y);
    resScl.w = dim.x; resScl.h = dim.y;
    resScl.attrs.set("value", "4700");
    
    fix.addedComponents.push(resSda);
    fix.addedComponents.push(resScl);
    
    fix.addedWires.push(new Wire(mcuId + ".A4", resSda.id + ".p1", "red"));
    fix.addedWires.push(new Wire(resSda.id + ".p2", targetVcc, "red"));
    
    fix.addedWires.push(new Wire(mcuId + ".A5", resScl.id + ".p1", "red"));
    fix.addedWires.push(new Wire(resScl.id + ".p2", targetVcc, "red"));

    fix.reasoning.push("Detected I2C bus activity without passive pull-ups.");
    fix.reasoning.push("Injecting 4.7k resistors to " + targetVcc + " for SDA (A4) and SCL (A5) lines.");
    return fix;
  }

  private createPullResistorFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("pull_resistor", "Add 10k pull-up resistor to floating input", 0.90);
    
    if (violation.componentIds.length > 0) {
       const compId = violation.componentIds[0];
       const comp = this.graph.components.get(compId);
       if (comp) {
          let mcuId = "uno1";
          let targetVcc = "uno1.5V";
          const componentKeys = this.graph.components.keys();
          for (let i = 0; i < componentKeys.length; i++) {
              const c = this.graph.components.get(componentKeys[i]);
              if (c!.type.includes("arduino-uno")) {
                  mcuId = componentKeys[i];
                  targetVcc = mcuId + ".5V";
                  break;
              }
          }

          const dim = this.getComponentDimensions("wokwi-resistor");
          const pos = this.findSafePosition(comp.x - 80, comp.y - 40, dim.x, dim.y);
          const res = new Component("fix_pull_" + compId, "wokwi-resistor", pos.x, pos.y);
          res.w = dim.x;
          res.h = dim.y;
          res.attrs.set("value", "10000");
          fix.addedComponents.push(res);
          
          // Connect to the first pin of the component (usually the input)
          const pinId = compId + ".1"; 
          fix.addedWires.push(new Wire(pinId, res.id + ".p1", "red"));
          fix.addedWires.push(new Wire(res.id + ".p2", targetVcc, "red"));

          fix.reasoning.push("Input pin detected in floating state (High-Z).");
          fix.reasoning.push("Adding a 10k pull-up resistor to " + targetVcc + " to provide a stable default state.");
       }
    }
    return fix;
  }

  private createGroundFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("missing_ground", "Connect component to ground rail", 0.98);
    
    if (violation.componentIds.length > 0) {
        const compId = violation.componentIds[0];
        const comp = this.graph.components.get(compId);
        if (comp) {
            const board = this.findBoard();
            if (board) {
                const boardId = board.id;
                const boardType = board.type.toLowerCase();
                let targetGnd = boardId + ".GND.1";
                if (boardType.includes("pico")) targetGnd = boardId + ".GND.1";
                else if (boardType.includes("esp32")) targetGnd = boardId + ".GND";
                
                // Connect pin '2' or 'GND' or 'K' to Ground
                let compPin = compId + ".2";
                if (comp.type.includes("led")) compPin = compId + ".K";
            
                fix.addedWires.push(new Wire(compPin, targetGnd, "black"));
                
                fix.reasoning.push("Component " + compId + " return path is missing a connection to GND.");
                fix.reasoning.push("Suggested shortest path connection to " + targetGnd + ".");
            }
        }
    }
    return fix;
  }

  private speculativeChainedAnalysis(fix: FixSuggestion): FixSuggestion {
    if (fix.id == "polarity_swap" || fix.id == "polarity_flip") {
      // Find the component being flipped or swapped
      let compId = "";
      if (fix.transformations.length > 0) {
          compId = fix.transformations[0].componentId;
      } else if (fix.description.includes("Swap wires for ")) {
          const parts = fix.description.split("Swap wires for ");
          if (parts.length > 1) {
              compId = parts[1].split(" ")[0];
          }
      }
      
      if (compId == "") return fix;

      const comp = this.graph.components.get(compId);
      if (comp && comp.type == "wokwi-led") {
        let hasResistor = false;
        const pins: string[] = ["A", "K"];
        for (let p = 0; p < pins.length; p++) {
          const node = compId + "." + pins[p];
          if (this.graph.adjacencyList.has(node)) {
            const neighbors = this.graph.adjacencyList.get(node);
            if (neighbors) {
              for (let n = 0; n < neighbors!.length; n++) {
                if (neighbors![n].includes("res")) {
                  hasResistor = true;
                  break;
                }
              }
            }
          }
          if (hasResistor) break;
        }

        if (!hasResistor) {
          fix.reasoning.push("Speculative Analysis: After flipping, this LED will lack current limiting.");
          fix.reasoning.push("Chaining Fix: Adding 220 Ohm series resistor and breaking direct net.");
          
          const res = new Component("fix_res_" + compId, "wokwi-resistor", comp.x + 60, comp.y + 20);
          res.attrs.set("value", "220");
          fix.addedComponents.push(res);
          
          // Break the current cathode connection and insert resistor
          const cathodePin = compId + ".K";
          const cathodeWires = this.graph.getWiresConnectedTo(cathodePin);
          let targetGnd = "GND";
          let origColor = "black";

          if (cathodeWires.length > 0) {
              const w = cathodeWires[0];
              targetGnd = w.from == cathodePin ? w.to : w.from;
              origColor = w.color;
              fix.removedWires.push(w.from + "->" + w.to);
          }

          fix.addedWires.push(new Wire(cathodePin, res.id + ".p1", "black"));
          fix.addedWires.push(new Wire(res.id + ".p2", targetGnd, origColor));
          
          fix.description += " & Add Series Resistor";
        }
      }
    }

    return fix;
  }

  private createPolarityFlipFix(violation: Violation): FixSuggestion {
    const fix = new FixSuggestion("polarity_swap", "Swap wiring pins to correct polarity", 0.99);
    
    if (violation.componentIds.length > 0) {
      const compId = violation.componentIds[0];
      const comp = this.graph.components.get(compId);
      if (comp) {
        // Find wires connected to A and K
        const pins: string[] = ["A", "K", "1", "2"];
        let p1: string = "";
        let p2: string = "";
        let w1: Wire | null = null;
        let w2: Wire | null = null;

        for (let i = 0; i < pins.length; i++) {
            const p = compId + "." + pins[i];
            const ws = this.graph.getWiresConnectedTo(p);
            if (ws.length > 0) {
                if (p1 == "") {
                    p1 = p;
                    w1 = ws[0];
                } else {
                    p2 = p;
                    w2 = ws[0];
                }
            }
        }

        if (w1 && w2) {
            // Swap destinations
            const dest1 = w1!.from == p1 ? w1!.to : w1!.from;
            const dest2 = w2!.from == p2 ? w2!.to : w2!.from;

            fix.removedWires.push(w1!.from + "->" + w1!.to);
            fix.removedWires.push(w2!.from + "->" + w2!.to);

            fix.addedWires.push(new Wire(p1, dest2, w1!.color));
            fix.addedWires.push(new Wire(p2, dest1, w2!.color));

            fix.description = "Swap wires for " + compId + " to fix polarity";
            fix.reasoning.push("Detected polarity mismatch on " + compId + ".");
            fix.reasoning.push("Instead of rotating component, swapping pins " + p1 + " and " + p2 + " connections.");
        } else {
            // Fallback to rotation if wiring is incomplete
            const newRotation = (comp.rotation + 180.0) % 360.0;
            fix.transformations.push(new Transformation(compId, newRotation));
            fix.description = "Flip " + compId + " orientation";
        }
      }
    }

    return this.speculativeChainedAnalysis(fix);
  }
}

// Export a singleton instance for WASM
const engine = new FixEngine();

export function reset(): void {
  engine.reset();
}

export function ingestComponent(id: string | null, type: string | null, x: f64, y: f64, rotation: f64): void {
  engine.ingestComponent(id, type, x, y, rotation);
}

export function getFixRemovedWireCount(index: i32): i32 {
  const plan = engine.generateFixPlan();
  if (index < 0 || index >= plan.length) return 0;
  return plan[index].removedWires.length;
}

export function getRemovedWireFrom(fixIndex: i32, wireIndex: i32): string {
  const plan = engine.generateFixPlan();
  const raw = plan[fixIndex].removedWires[wireIndex];
  const parts = raw.split("->");
  return parts[0];
}

export function getRemovedWireTo(fixIndex: i32, wireIndex: i32): string {
  const plan = engine.generateFixPlan();
  const raw = plan[fixIndex].removedWires[wireIndex];
  const parts = raw.split("->");
  if (parts.length < 2) return "";
  return parts[1];
}

export function ingestWire(from: string | null, to: string | null, color: string | null): void {
  if (from && to) {
    engine.ingestWire(from!, to!, color ? color! : "green");
  }
}

export function ingestViolation(ruleId: string | null, message: string | null, componentIds: string | null, severity: string | null): void {
  engine.ingestViolation(ruleId, message, componentIds, severity);
}

export function getFixPlanCount(): i32 {
  return engine.generateFixPlan().length;
}

export function getFixDescription(index: i32): string {
  const plan = engine.generateFixPlan();
  if (index < 0 || index >= plan.length) return "";
  return plan[index].description;
}

export function getFixAddedComponentCount(index: i32): i32 {
  const plan = engine.generateFixPlan();
  if (index < 0 || index >= plan.length) return 0;
  return plan[index].addedComponents.length;
}

export function getFixAddedWireCount(index: i32): i32 {
  const plan = engine.generateFixPlan();
  if (index < 0 || index >= plan.length) return 0;
  return plan[index].addedWires.length;
}

export function getAddedComponentId(fixIndex: i32, compIndex: i32): string {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].addedComponents[compIndex].id;
}

export function getAddedComponentType(fixIndex: i32, compIndex: i32): string {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].addedComponents[compIndex].type;
}

export function getAddedComponentX(fixIndex: i32, compIndex: i32): f64 {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].addedComponents[compIndex].x;
}

export function getAddedComponentY(fixIndex: i32, compIndex: i32): f64 {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].addedComponents[compIndex].y;
}

export function getAddedWireFrom(fixIndex: i32, wireIndex: i32): string {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].addedWires[wireIndex].from;
}

export function getAddedWireTo(fixIndex: i32, wireIndex: i32): string {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].addedWires[wireIndex].to;
}

export function getAddedWirePathPointCount(fixIndex: i32, wireIndex: i32): i32 {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].addedWires[wireIndex].path.length;
}

export function getAddedWirePathPointX(fixIndex: i32, wireIndex: i32, pointIndex: i32): f64 {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].addedWires[wireIndex].path[pointIndex].x;
}

export function getAddedWirePathPointY(fixIndex: i32, wireIndex: i32, pointIndex: i32): f64 {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].addedWires[wireIndex].path[pointIndex].y;
}

export function getFixReasoningCount(index: i32): i32 {
  const plan = engine.generateFixPlan();
  if (index < 0 || index >= plan.length) return 0;
  return plan[index].reasoning.length;
}

export function getFixReasoningStep(fixIndex: i32, stepIndex: i32): string {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].reasoning[stepIndex];
}

export function getFixTransformationCount(index: i32): i32 {
  const plan = engine.generateFixPlan();
  if (index < 0 || index >= plan.length) return 0;
  return plan[index].transformations.length;
}

export function getTransformationComponentId(fixIndex: i32, transIndex: i32): string {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].transformations[transIndex].componentId;
}

export function getTransformationRotation(fixIndex: i32, transIndex: i32): f64 {
  const plan = engine.generateFixPlan();
  return plan[fixIndex].transformations[transIndex].rotation;
}

