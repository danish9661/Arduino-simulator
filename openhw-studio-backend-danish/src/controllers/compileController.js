import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find arduino-cli globally via system PATH
const ARDUINO_CLI_PATH = 'arduino-cli';
const TEMP_DIR = path.resolve(__dirname, '../../temp');
const UF2_PAYLOAD_PREFIX = 'UF2BASE64:';
const DEFAULT_PICO_MICROPYTHON_UF2_SOURCE = String(
    process.env.PICO_MICROPYTHON_UART0_UF2_URL
    || process.env.PICO_MICROPYTHON_UF2_URL
    || ''
).trim();
const PICO_MICROPYTHON_CACHE_TTL_MS = Number(process.env.PICO_MICROPYTHON_CACHE_TTL_MS || (1000 * 60 * 60 * 6));

let picoMicropythonUf2Cache = null;

function resolvePicoMicropythonUf2Source() {
    const source = DEFAULT_PICO_MICROPYTHON_UF2_SOURCE;
    if (!source) {
        throw new Error('Missing PICO_MICROPYTHON_UART0_UF2_URL (or PICO_MICROPYTHON_UF2_URL) for Pico MicroPython UF2 source.');
    }

    const lower = source.toLowerCase();
    if (lower.includes('micropython.org/resources/firmware/rpi_pico')) {
        throw new Error('Configured UF2 source points to official micropython.org firmware (USB CDC REPL). Use a UART0-enabled Pico MicroPython UF2 build.');
    }

    if (/^https?:\/\//i.test(source)) {
        return { kind: 'url', value: source };
    }

    const filePath = path.isAbsolute(source)
        ? source
        : path.resolve(__dirname, '../../', source);
    return { kind: 'file', value: filePath };
}

function sanitizeSketchName(name) {
    const base = String(name || '').trim() || 'sketch';
    return base.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sanitizeFileName(name) {
    const base = path.basename(String(name || '').trim());
    return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensureAllowedSourceExt(name) {
    const ext = path.extname(name).toLowerCase();
    return ['.ino', '.h', '.hpp', '.c', '.cpp'].includes(ext);
}

function sanitizePortName(name) {
    return String(name || '').trim().replace(/[^a-zA-Z0-9_:\/.\\-]/g, '');
}

function resolveCompileArtifact(buildDir, targetFqbn) {
    const outFiles = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
    const lowerFqbn = String(targetFqbn || '').toLowerCase();
    const preferredExts = lowerFqbn.includes('rp2040')
        ? ['.uf2', '.hex']
        : ['.hex', '.uf2'];

    for (const ext of preferredExts) {
        const outputName = outFiles.find((name) => name.toLowerCase().endsWith(ext));
        if (!outputName) continue;

        const artifactPath = path.join(buildDir, outputName);
        if (ext === '.hex') {
            const text = fs.readFileSync(artifactPath, 'utf8');
            return {
                payload: text,
                artifactType: 'hex',
                artifactName: outputName,
                outputFiles: outFiles,
            };
        }

        const raw = fs.readFileSync(artifactPath);
        return {
            payload: `${UF2_PAYLOAD_PREFIX}${raw.toString('base64')}`,
            artifactType: 'uf2',
            artifactName: outputName,
            outputFiles: outFiles,
        };
    }

    return {
        payload: '',
        artifactType: null,
        artifactName: null,
        outputFiles: outFiles,
    };
}

function resolveElfArtifact(buildDir) {
    const outFiles = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
    const elfName = outFiles.find((name) => name.toLowerCase().endsWith('.elf'));
    if (!elfName) {
        return {
            elfPayload: '',
            elfName: null,
        };
    }

    const elfPath = path.join(buildDir, elfName);
    const raw = fs.readFileSync(elfPath);
    return {
        elfPayload: `ELFBASE64:${raw.toString('base64')}`,
        elfName,
    };
}

function resolveGdbMeta(targetFqbn = '') {
    const fqbn = String(targetFqbn || '').toLowerCase();
    if (fqbn.includes('rp2040') || fqbn.includes('pico')) {
        return {
            arch: 'arm',
            gdb: 'arm-none-eabi-gdb',
            targetRemote: 'localhost:3333',
        };
    }

    if (fqbn.includes('avr') || fqbn.includes('arduino:avr')) {
        return {
            arch: 'avr',
            gdb: 'avr-gdb',
            targetRemote: 'localhost:3555',
        };
    }

    return {
        arch: 'unknown',
        gdb: 'gdb-multiarch',
        targetRemote: 'localhost:3333',
    };
}

function resolvePicoSdkPath() {
    const envPath = String(process.env.PICO_SDK_PATH || '').trim();
    const candidates = [
        envPath,
        path.resolve(__dirname, '../../external/pico-sdk'),
        path.resolve(process.cwd(), 'external/pico-sdk'),
        path.resolve(process.cwd(), 'openhw-studio-backend-danish/external/pico-sdk'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        const importCmake = path.join(candidate, 'external', 'pico_sdk_import.cmake');
        if (fs.existsSync(importCmake)) {
            return candidate;
        }
    }
    return '';
}

function resolveRp2040ToolchainPaths() {
    const compilerExe = os.platform() === 'win32' ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc';
    const explicit = String(process.env.PICO_TOOLCHAIN_PATH || '').trim();
    if (explicit) {
        const explicitBin = path.join(explicit, 'bin');
        const explicitExeInBin = path.join(explicitBin, compilerExe);
        const explicitExeDirect = path.join(explicit, compilerExe);
        if (fs.existsSync(explicitExeInBin)) {
            return { root: explicit, bin: explicitBin };
        }
        if (fs.existsSync(explicitExeDirect)) {
            return { root: path.dirname(explicit), bin: explicit };
        }
    }

    const dataCandidates = [
        String(process.env.ARDUINO_DATA_DIR || '').trim(),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Arduino15') : '',
        process.env.APPDATA ? path.join(process.env.APPDATA, 'Arduino15') : '',
    ].filter(Boolean);

    for (const dataDir of dataCandidates) {
        const toolsRoot = path.join(dataDir, 'packages', 'rp2040', 'tools', 'pqt-gcc');
        if (!fs.existsSync(toolsRoot)) continue;

        const versions = fs.readdirSync(toolsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

        for (const version of versions) {
            const root = path.join(toolsRoot, version);
            const bin = path.join(root, 'bin');
            const gccExe = path.join(bin, compilerExe);
            if (fs.existsSync(gccExe)) {
                return { root, bin };
            }
        }
    }

    return { root: '', bin: '' };
}

function resolveRp2040PicotoolExecutable() {
    const exeName = os.platform() === 'win32' ? 'picotool.exe' : 'picotool';
    const explicitExe = String(process.env.PICO_PICOTOOL_EXE || '').trim();
    if (explicitExe && fs.existsSync(explicitExe)) {
        return explicitExe;
    }

    const explicitDir = String(process.env.PICO_PICOTOOL_DIR || '').trim();
    if (explicitDir) {
        const explicitCandidate = path.join(explicitDir, exeName);
        if (fs.existsSync(explicitCandidate)) {
            return explicitCandidate;
        }
    }

    const dataCandidates = [
        String(process.env.ARDUINO_DATA_DIR || '').trim(),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Arduino15') : '',
        process.env.APPDATA ? path.join(process.env.APPDATA, 'Arduino15') : '',
    ].filter(Boolean);

    for (const dataDir of dataCandidates) {
        const toolsRoot = path.join(dataDir, 'packages', 'rp2040', 'tools', 'pqt-picotool');
        if (!fs.existsSync(toolsRoot)) continue;

        const versions = fs.readdirSync(toolsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

        for (const version of versions) {
            const exePath = path.join(toolsRoot, version, exeName);
            if (fs.existsSync(exePath)) {
                return exePath;
            }
        }
    }

    return '';
}

function resolveNinjaExecutable() {
    const envNinja = String(process.env.CMAKE_MAKE_PROGRAM || process.env.NINJA || '').trim();
    const candidates = [
        envNinja,
        path.resolve(__dirname, '../../../.venv/Scripts/ninja.exe'),
        path.resolve(__dirname, '../../env/Scripts/ninja.exe'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    // On unix-like systems we can usually rely on PATH if not found above.
    if (os.platform() !== 'win32') {
        return 'ninja';
    }

    return '';
}

function execFileAsync(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, (error, stdout, stderr) => {
            if (error) return reject(new Error(stderr || stdout || error.message));
            resolve({ stdout, stderr });
        });
    });
}

function normalizePortEntry(address, meta = {}) {
    return {
        port: String(address || ''),
        label: meta.label || String(address || ''),
        protocol: meta.protocol || '',
        boardName: meta.boardName || '',
        fqbn: meta.fqbn || '',
        source: meta.source || 'system',
    };
}

async function listDetectedArduinoPorts() {
    try {
        const { stdout } = await execFileAsync(ARDUINO_CLI_PATH, ['board', 'list', '--format', 'json']);
        const parsed = JSON.parse(stdout || '{}');
        const rows = Array.isArray(parsed?.detected_ports) ? parsed.detected_ports : [];
        const out = [];

        rows.forEach((r) => {
            const address = r?.port?.address;
            if (!address) return;
            const bestMatch = Array.isArray(r?.matching_boards) ? r.matching_boards[0] : null;
            out.push(normalizePortEntry(address, {
                label: `${address}${bestMatch?.name ? ` (${bestMatch.name})` : ''}`,
                protocol: r?.port?.protocol || '',
                boardName: bestMatch?.name || '',
                fqbn: bestMatch?.fqbn || '',
                source: 'detected',
            }));
        });
        return out;
    } catch {
        return [];
    }
}

async function listSystemSerialPorts() {
    const platform = os.platform();
    if (platform === 'win32') {
        try {
            const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object | ConvertTo-Json -Compress']);
            const parsed = JSON.parse(stdout || '[]');
            const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
            return arr.map((p) => normalizePortEntry(p, { source: 'system' }));
        } catch {
            return [];
        }
    }

    // Basic fallback for unix-like systems
    const patterns = ['/dev/ttyUSB', '/dev/ttyACM', '/dev/cu.usb'];
    try {
        const devEntries = fs.readdirSync('/dev');
        return devEntries
            .map((name) => `/dev/${name}`)
            .filter((full) => patterns.some((p) => full.startsWith(p)))
            .map((p) => normalizePortEntry(p, { source: 'system' }));
    } catch {
        return [];
    }
}

async function fetchPicoMicropythonUf2Asset() {
    const sourceInfo = resolvePicoMicropythonUf2Source();
    const now = Date.now();
    const isFresh = picoMicropythonUf2Cache
        && (now - picoMicropythonUf2Cache.fetchedAt) < PICO_MICROPYTHON_CACHE_TTL_MS;

    if (isFresh) {
        return { ...picoMicropythonUf2Cache, cacheState: 'hit' };
    }

    try {
        if (sourceInfo.kind === 'url') {
            const upstream = await fetch(sourceInfo.value, {
                headers: {
                    'user-agent': 'OpenHW-Studio-Backend/1.0',
                },
            });

            if (!upstream.ok) {
                throw new Error(`Upstream UF2 fetch failed (${upstream.status})`);
            }

            const arrBuf = await upstream.arrayBuffer();
            const buffer = Buffer.from(arrBuf);
            const parsed = new URL(sourceInfo.value);
            const fileName = path.basename(parsed.pathname || '') || 'pico-micropython-uart0.uf2';

            picoMicropythonUf2Cache = {
                buffer,
                fileName,
                fetchedAt: now,
                contentType: upstream.headers.get('content-type') || 'application/octet-stream',
            };
        } else {
            const buffer = fs.readFileSync(sourceInfo.value);
            const fileName = path.basename(sourceInfo.value) || 'pico-micropython-uart0.uf2';

            picoMicropythonUf2Cache = {
                buffer,
                fileName,
                fetchedAt: now,
                contentType: 'application/octet-stream',
            };
        }

        return { ...picoMicropythonUf2Cache, cacheState: 'miss' };
    } catch (err) {
        if (picoMicropythonUf2Cache) {
            return { ...picoMicropythonUf2Cache, cacheState: 'stale' };
        }
        throw err;
    }
}

export const compileArduinoCode = (req, res) => {
    const { code, files, sketchName, fqbn, builder } = req.body || {};

    if (!code && (!Array.isArray(files) || files.length === 0)) {
        return res.status(400).json({ error: 'No code or files provided.' });
    }

    // Create a unique temporary directory for this sketch
    const sketchId = crypto.randomBytes(8).toString('hex');
    const safeSketchName = sanitizeSketchName(sketchName || `sketch_${sketchId}`);
    const sketchFolderName = `${safeSketchName}_${sketchId}`;
    const sketchDir = path.join(TEMP_DIR, sketchFolderName);
    // Arduino CLI requires the primary .ino name to match the sketch folder name.
    const mainSketchFile = path.join(sketchDir, `${sketchFolderName}.ino`);
    const buildDir = path.join(sketchDir, 'build');

    try {
        fs.mkdirSync(sketchDir, { recursive: true });
        fs.mkdirSync(buildDir, { recursive: true });

        const validFiles = Array.isArray(files) ? files
            .filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string')
            .map((f) => ({
                name: sanitizeFileName(f.name),
                content: f.content,
            }))
            .filter((f) => ensureAllowedSourceExt(f.name))
            : [];

        const namedIno = validFiles.find((f) => {
            const ext = path.extname(f.name).toLowerCase();
            if (ext !== '.ino') return false;
            const base = path.basename(f.name, ext);
            return sanitizeSketchName(base) === safeSketchName;
        });
        const firstIno = validFiles.find((f) => path.extname(f.name).toLowerCase() === '.ino');
        const mainSourceName = namedIno?.name || firstIno?.name || null;

        validFiles
            .filter((f) => !mainSourceName || f.name !== mainSourceName)
            .forEach((f) => {
                fs.writeFileSync(path.join(sketchDir, f.name), f.content);
            });

        const mainCode = (typeof code === 'string' && code.length > 0)
            ? code
            : (namedIno?.content || firstIno?.content || 'void setup(){}\nvoid loop(){}\n');

        fs.writeFileSync(mainSketchFile, mainCode);
    } catch (err) {
        console.error('Error creating temp files:', err);
        return res.status(500).json({ error: 'Failed to create temporary build environment.' });
    }

    // Handle pico-sdk builder
    if (builder === 'pico-sdk') {
        const picoSdkPath = resolvePicoSdkPath();
        if (!picoSdkPath) {
            fs.rm(sketchDir, { recursive: true, force: true }, () => {});
            return res.status(400).json({
                error: 'Pico SDK build failed',
                details: 'PICO_SDK_PATH is not configured and no local SDK was found at openhw-studio-backend-danish/external/pico-sdk.',
            });
        }

        const toolchain = resolveRp2040ToolchainPaths();
        if (!toolchain.root || !toolchain.bin) {
            fs.rm(sketchDir, { recursive: true, force: true }, () => {});
            return res.status(400).json({
                error: 'Pico SDK build failed',
                details: 'ARM toolchain not found for Pico SDK. Install/repair Arduino RP2040 core (rp2040:rp2040) or set PICO_TOOLCHAIN_PATH.',
            });
        }

        const ninjaExe = resolveNinjaExecutable();
        if (!ninjaExe) {
            fs.rm(sketchDir, { recursive: true, force: true }, () => {});
            return res.status(400).json({
                error: 'Pico SDK build failed',
                details: 'Ninja build tool was not found. Install Ninja or set CMAKE_MAKE_PROGRAM to ninja executable.',
            });
        }

        const picotoolExe = resolveRp2040PicotoolExecutable();

        const cmakelists = path.join(sketchDir, 'CMakeLists.txt');
        if (!fs.existsSync(cmakelists)) {
            let sources = [];
            // Gather written files
            const filesInDir = fs.readdirSync(sketchDir);
            for (const f of filesInDir) {
                if (f.endsWith('.c') || f.endsWith('.cpp') || f.endsWith('.S')) {
                    sources.push(f);
                }
            }
            if (sources.length === 0) {
                // If there were no .c/.cpp files, then rename the main sketch to .cpp so cmake handles it
                const cppName = `${sketchFolderName}.cpp`;
                fs.renameSync(mainSketchFile, path.join(sketchDir, cppName));
                sources.push(cppName);
            }
            const picotoolShim = picotoolExe
                ? [
                    'if (DEFINED ENV{PICO_PICOTOOL_EXE} AND NOT TARGET picotool)',
                    'file(TO_CMAKE_PATH "$ENV{PICO_PICOTOOL_EXE}" OPENHW_PICOTOOL_EXE)',
                    'if (EXISTS "${OPENHW_PICOTOOL_EXE}")',
                    'add_executable(picotool IMPORTED GLOBAL)',
                    'set_property(TARGET picotool PROPERTY IMPORTED_LOCATION "${OPENHW_PICOTOOL_EXE}")',
                    'message(STATUS "Using preinstalled picotool at ${OPENHW_PICOTOOL_EXE}")',
                    'endif()',
                    'endif()',
                    '',
                ].join('\n')
                : '';
            const cmaketemplated = `cmake_minimum_required(VERSION 3.13)
include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)
project(pico_project)
${picotoolShim}pico_sdk_init()
add_executable(firmware ${sources.join(' ')})
pico_enable_stdio_usb(firmware 1)
pico_enable_stdio_uart(firmware 1)
target_link_libraries(firmware pico_stdlib)
pico_add_extra_outputs(firmware)
`;
            fs.writeFileSync(cmakelists, cmaketemplated);
        }

        const cmakeEnv = {
            ...process.env,
            PICO_SDK_PATH: picoSdkPath,
            PICO_TOOLCHAIN_PATH: toolchain.root,
            ...(picotoolExe ? { PICO_PICOTOOL_EXE: picotoolExe.replace(/\\/g, '/') } : {}),
            PATH: `${toolchain.bin}${path.delimiter}${path.dirname(ninjaExe)}${picotoolExe ? `${path.delimiter}${path.dirname(picotoolExe)}` : ''}${path.delimiter}${process.env.PATH || ''}`,
        };

        const configureArgs = [
            '-S',
            sketchDir,
            '-B',
            buildDir,
            '-G',
            'Ninja',
            `-DCMAKE_MAKE_PROGRAM=${ninjaExe}`,
            `-DPICO_SDK_PATH=${picoSdkPath}`,
            `-DPICO_TOOLCHAIN_PATH=${toolchain.root}`,
            '-DPICO_BOARD=pico',
        ];

        execFile('cmake', configureArgs, { cwd: sketchDir, env: cmakeEnv }, (cfgErr, cfgStdout, cfgStderr) => {
            if (cfgErr) {
                console.error('Pico SDK configure error:', cfgStderr || cfgStdout);
                fs.rm(sketchDir, { recursive: true, force: true }, () => {});
                return res.status(400).json({
                    error: 'Pico SDK build failed',
                    details: cfgStderr || cfgStdout,
                });
            }

            execFile('cmake', ['--build', buildDir, '--target', 'firmware', '--config', 'Release'], { cwd: sketchDir, env: cmakeEnv }, (buildErr, buildStdout, buildStderr) => {
                if (buildErr) {
                    console.error('Pico SDK build error:', buildStderr || buildStdout);
                    fs.rm(sketchDir, { recursive: true, force: true }, () => {});
                    return res.status(400).json({
                        error: 'Pico SDK build failed',
                        details: `${cfgStderr || cfgStdout}\n${buildStderr || buildStdout}`.trim(),
                    });
                }

                try {
                    const uf2Files = fs.readdirSync(buildDir).filter((f) => f.toLowerCase().endsWith('.uf2'));
                    if (uf2Files.length === 0) throw new Error('No .uf2 file found in build output.');

                    const uf2Path = path.join(buildDir, uf2Files[0]);
                    const uf2Raw = fs.readFileSync(uf2Path);
                    const uf2Payload = `${UF2_PAYLOAD_PREFIX}${uf2Raw.toString('base64')}`;

                    let elfPayload = '';
                    const elfFiles = fs.readdirSync(buildDir).filter((f) => f.toLowerCase().endsWith('.elf'));
                    if (elfFiles.length > 0) {
                        elfPayload = `ELFBASE64:${fs.readFileSync(path.join(buildDir, elfFiles[0])).toString('base64')}`;
                    }

                    fs.rm(sketchDir, { recursive: true, force: true }, () => {});

                    return res.json({
                        hex: uf2Payload,
                        artifactType: 'uf2',
                        artifactName: uf2Files[0],
                        elf: elfPayload,
                        elfName: elfFiles.length > 0 ? elfFiles[0] : null,
                        gdb: resolveGdbMeta('rp2040'),
                        stdout: `${cfgStdout || ''}\n${buildStdout || ''}`.trim(),
                    });
                } catch (err) {
                    console.error('Error extracting UF2:', err);
                    fs.rm(sketchDir, { recursive: true, force: true }, () => {});
                    return res.status(500).json({ error: 'Failed to extract UF2.', details: err.message });
                }
            });
        });
        return;
    }

    // Compile using arduino-cli
    // We specify target FQBN as arduino:avr:uno
    const targetFqbn = typeof fqbn === 'string' && fqbn.trim() ? fqbn.trim() : 'arduino:avr:uno';
    execFile(ARDUINO_CLI_PATH, ['compile', '--fqbn', targetFqbn, '--output-dir', buildDir, sketchDir], (error, stdout, stderr) => {
        // Read produced firmware artifact regardless of warnings, but handle hard errors.
        let compiledArtifact = {
            payload: '',
            artifactType: null,
            artifactName: null,
            outputFiles: [],
        };
        let elfArtifact = {
            elfPayload: '',
            elfName: null,
        };

        try {
            compiledArtifact = resolveCompileArtifact(buildDir, targetFqbn);
            elfArtifact = resolveElfArtifact(buildDir);
        } catch {
            compiledArtifact = {
                payload: '',
                artifactType: null,
                artifactName: null,
                outputFiles: [],
            };
            elfArtifact = {
                elfPayload: '',
                elfName: null,
            };
        }

        // Cleanup temp directory asynchronously
        fs.rm(sketchDir, { recursive: true, force: true }, (rmErr) => {
            if (rmErr) console.error(`Failed to clean up sketch dir: ${sketchDir}`, rmErr);
        });

        if (error && !compiledArtifact.payload) {
            console.error('Compile error:', stderr || stdout);
            return res.status(400).json({
                error: 'Compilation failed',
                details: stderr || stdout
            });
        }

        if (!compiledArtifact.payload) {
            return res.status(500).json({
                error: 'Compilation finished but no firmware artifact was produced.',
                details: `Expected .hex${String(targetFqbn).toLowerCase().includes('rp2040') ? ' or .uf2' : ''} in build output. Found: ${compiledArtifact.outputFiles.join(', ') || '(none)'}`,
            });
        }

        return res.json({
            hex: compiledArtifact.payload,
            artifactType: compiledArtifact.artifactType,
            artifactName: compiledArtifact.artifactName,
            elf: elfArtifact.elfPayload,
            elfName: elfArtifact.elfName,
            gdb: resolveGdbMeta(targetFqbn),
            stdout: stdout,
        });
    });
};

export const flashFirmware = (req, res) => {
    const { port, fqbn, hex, baudRate, resetMethod } = req.body || {};
    const cleanPort = sanitizePortName(port);
    const targetFqbn = typeof fqbn === 'string' && fqbn.trim() ? fqbn.trim() : 'arduino:avr:uno';
    const hexContent = typeof hex === 'string' ? hex.trim() : '';
    const cleanBaud = Number(baudRate);

    if (!cleanPort) {
        return res.status(400).json({ error: 'Missing hardware port. Example: COM3 or /dev/ttyUSB0.' });
    }
    if (!hexContent) {
        return res.status(400).json({ error: 'Missing HEX firmware content.' });
    }

    const flashId = crypto.randomBytes(8).toString('hex');
    const flashDir = path.join(TEMP_DIR, `flash_${flashId}`);
    const hexFile = path.join(flashDir, `firmware_${flashId}.hex`);

    try {
        fs.mkdirSync(flashDir, { recursive: true });
        fs.writeFileSync(hexFile, hexContent, 'utf8');
    } catch (err) {
        console.error('Error creating flash temp files:', err);
        return res.status(500).json({ error: 'Failed to create temporary flash files.' });
    }

    const args = [
        'upload',
        '--fqbn', targetFqbn,
        '-p', cleanPort,
        '--input-file', hexFile,
        '--verify',
    ];

    if (Number.isFinite(cleanBaud) && cleanBaud > 0) {
        args.push('--upload-property', `upload.speed=${Math.trunc(cleanBaud)}`);
    }
    if (String(resetMethod || '').toLowerCase() === 'no-rts-dtr') {
        // Core-dependent, may be ignored by some board packages.
        args.push('--upload-property', 'upload.disable_flushing=true');
    }

    execFile(ARDUINO_CLI_PATH, args, (error, stdout, stderr) => {
        fs.rm(flashDir, { recursive: true, force: true }, (rmErr) => {
            if (rmErr) console.error(`Failed to clean up flash dir: ${flashDir}`, rmErr);
        });

        if (error) {
            console.error('Flash error:', stderr || stdout);
            return res.status(400).json({
                error: 'Flashing failed',
                details: stderr || stdout,
            });
        }

        return res.json({
            ok: true,
            message: 'Firmware flashed successfully via bootloader uploader.',
            output: stdout || stderr || '',
        });
    });
};

export const listSerialPorts = async (req, res) => {
    const showAll = String(req.query.showAll || 'false').toLowerCase() === 'true';
    try {
        const detected = await listDetectedArduinoPorts();
        if (!showAll) {
            return res.json({ ports: detected });
        }

        const system = await listSystemSerialPorts();
        const merged = new Map();
        [...detected, ...system].forEach((p) => {
            if (!p?.port) return;
            if (!merged.has(p.port)) merged.set(p.port, p);
            else if (merged.get(p.port).source !== 'detected' && p.source === 'detected') merged.set(p.port, p);
        });

        return res.json({ ports: Array.from(merged.values()) });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to list serial ports', details: err.message });
    }
};

export const getDefaultPicoMicroPythonUf2 = async (req, res) => {
    try {
        const asset = await fetchPicoMicropythonUf2Asset();

        res.setHeader('Content-Type', asset.contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${asset.fileName || 'pico-micropython.uf2'}"`);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('X-OpenHW-UF2-Cache', asset.cacheState || 'unknown');

        return res.status(200).send(asset.buffer);
    } catch (err) {
        return res.status(502).json({
            error: 'Failed to fetch default Pico MicroPython UF2',
            details: err?.message || 'Unknown error',
        });
    }
};
