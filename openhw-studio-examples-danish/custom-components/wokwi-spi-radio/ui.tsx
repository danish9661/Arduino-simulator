import React from 'react';

export const BOUNDS = { x: 0, y: 0, w: 140, h: 90 };

export const SpiRadioUI = ({ state, attrs, isRunning }) => {
  const selected = !!state?.selected;
  const irq0 = !!state?.irq0;
  const irq2 = !!state?.irq2;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <svg width={140} height={90} viewBox="0 0 140 90" style={{ pointerEvents: 'none' }}>
        <rect x="4" y="8" width="132" height="74" rx="8" fill="#1f2b3a" stroke={selected ? '#00d4ff' : '#5e6f85'} strokeWidth="2" />
        <text x="70" y="28" textAnchor="middle" fill="#dce8f5" fontSize="11" fontFamily="monospace">SPI RADIO</text>
        <text x="70" y="42" textAnchor="middle" fill="#8fb3d9" fontSize="9" fontFamily="monospace">TX:{state?.txDepth ?? 0} RX:{state?.rxDepth ?? 0}</text>

        <circle cx="70" cy="58" r="5" fill={irq0 ? '#22c55e' : '#243447'} />
        <text x="70" y="75" textAnchor="middle" fill="#8fb3d9" fontSize="8" fontFamily="monospace">GDO0</text>

        <circle cx="90" cy="58" r="5" fill={irq2 ? '#f59e0b' : '#243447'} />
        <text x="90" y="75" textAnchor="middle" fill="#8fb3d9" fontSize="8" fontFamily="monospace">GDO2</text>
      </svg>

      <button
        style={{
          pointerEvents: isRunning ? 'auto' : 'none',
          position: 'absolute',
          left: 8,
          top: 54,
          fontSize: 10,
          padding: '2px 6px',
          border: '1px solid #44556a',
          borderRadius: 4,
          background: '#0d1520',
          color: '#dce8f5',
          cursor: isRunning ? 'pointer' : 'default'
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={() => attrs?.onInteract?.({ type: 'CLEAR_IRQ' })}
      >
        CLR IRQ
      </button>
    </div>
  );
};

export const SpiRadioContextMenu = ({ attrs, onUpdate }) => (
  <>
    <span style={{ fontSize: 12, color: 'var(--text2)' }}>IRQ on TX write</span>
    <input
      type="checkbox"
      checked={!!attrs?.irqOnWrite}
      onChange={(e) => onUpdate('irqOnWrite', e.target.checked)}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    />
  </>
);

export const contextMenuDuringRun = true;
