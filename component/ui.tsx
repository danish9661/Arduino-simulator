import React from 'react';

// MANDATORY: Bounding box for selection ring and hit area
export const BOUNDS = { x: 0, y: 0, w: 100, h: 40 };

// Visibility flags for frontend dynamic sync
export const contextMenuDuringRun = true;
export const contextMenuOnlyDuringRun = true;

// Context Menu for live tuning
export const LdrContextMenu = ({ attrs, onUpdate }: { attrs: any, onUpdate: (key: string, value: any) => void }) => {
    const lux = attrs?.lux ?? 500;
    const threshold = attrs?.threshold ?? 500;

    // Update manifest attributes AND send data to the running Web Worker
    const handleSlider = (key: string, value: number) => {
        onUpdate(key, value);
        if (attrs && attrs.onInteract) {
            attrs.onInteract({ type: 'SET_ATTR', key, value });
        }
    };

    // Helper to stop all canvas events from triggering when interacting with the slider
    const stopProp = (e: React.MouseEvent | React.PointerEvent | React.TouchEvent) => e.stopPropagation();

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px' }} data-contextmenu="true">
            <div style={{ display: 'flex', flexDirection: 'column' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)', marginBottom: '2px' }}>Lux: {lux}</label>
                <input
                    type="range" min="0" max="1000" value={lux}
                    onChange={(e) => handleSlider('lux', parseFloat(e.target.value))}
                    onPointerDown={stopProp}
                    onMouseDown={stopProp}
                    onTouchStart={stopProp}
                    onDoubleClick={stopProp}
                    style={{ width: '80px', cursor: 'pointer' }}
                />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)', marginBottom: '2px' }}>Threshold: {threshold}</label>
                <input
                    type="range" min="0" max="1000" value={threshold}
                    onChange={(e) => handleSlider('threshold', parseFloat(e.target.value))}
                    onPointerDown={stopProp}
                    onMouseDown={stopProp}
                    onTouchStart={stopProp}
                    onDoubleClick={stopProp}
                    style={{ width: '80px', cursor: 'pointer' }}
                />
            </div>
        </div>
    );
};

export const LdrModuleUI = ({ state, attrs }: { state: any, attrs: any }) => {
    const pwrLed = state?.pwrLed || false;
    const doLed = state?.doLed || false;

    return (
        // CRITICAL FIX: Added pointerEvents: 'none' so clicks pass through the SVG 
        // to the simulator's Hit Box, allowing the component to be selected during runtime.
        <div style={{ pointerEvents: 'none', position: 'relative', width: 100, height: 40 }}>
            <svg width="100" height="40" viewBox="0 0 100 40">
                {/* Main PCB */}
                <rect x="15" y="0" width="70" height="40" fill="#1b223c" />
                <circle cx="20" cy="5" r="2" fill="#d1d8e0" />
                <circle cx="20" cy="35" r="2" fill="#d1d8e0" />

                {/* LDR Head */}
                <rect x="0" y="10" width="8" height="20" fill="#c0392b" rx="2" />
                <line x1="8" y1="15" x2="15" y2="15" stroke="#bdc3c7" strokeWidth="2" />
                <line x1="8" y1="25" x2="15" y2="25" stroke="#bdc3c7" strokeWidth="2" />

                {/* Potentiometer & IC */}
                <rect x="38" y="2" width="20" height="20" fill="#2980b9" />
                <circle cx="48" cy="12" r="6" fill="#ecf0f1" />
                <rect x="38" y="25" width="16" height="12" fill="#2c3e50" />

                {/* Status LEDs */}
                <rect x="63" y="10" width="6" height="4" fill={pwrLed ? "#e74c3c" : "#551111"} />
                <rect x="63" y="25" width="6" height="4" fill={doLed ? "#2ecc71" : "#114422"} />

                {/* Labels and Pins */}
                <text x="75" y="10" fontSize="6" fill="white">VCC</text>
                <text x="75" y="18" fontSize="6" fill="white">GND</text>
                <text x="75" y="26" fontSize="6" fill="white">DO</text>
                <text x="75" y="34" fontSize="6" fill="white">AO</text>

                {[8, 16, 24, 32].map(y => (
                    <line key={`pin-${y}`} x1="85" y1={y} x2="100" y2={y} stroke="silver" strokeWidth="2" />
                ))}
            </svg>
        </div>
    );
};