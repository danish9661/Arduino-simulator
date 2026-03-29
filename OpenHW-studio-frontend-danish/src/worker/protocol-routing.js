import {
  PICO_SOFTSERIAL_PINS,
  PICO_UART_PINS,
  UNO_SOFTSERIAL_PINS,
  UNO_UART_PINS,
} from './board-profiles';

export function isProgrammableBoardType(type) {
  return /(arduino|esp32|stm32|rp2040|pico)/i.test(String(type || ''));
}

export function endpointAliases(endpoint) {
  const [compId, pinIdRaw] = String(endpoint || '').split(':');
  const pinId = String(pinIdRaw || '');
  if (!compId || !pinId) return [String(endpoint || '')];

  const aliases = new Set([`${compId}:${pinId}`]);
  if (/^D\d+$/i.test(pinId)) aliases.add(`${compId}:${pinId.substring(1)}`);
  if (/^\d+$/.test(pinId)) aliases.add(`${compId}:D${pinId}`);
  if (/^GPIO\d+$/i.test(pinId)) aliases.add(`${compId}:${pinId.replace(/^GPIO/i, '')}`);
  if (/^GP\d+$/i.test(pinId)) aliases.add(`${compId}:${pinId.replace(/^GP/i, '')}`);
  return Array.from(aliases);
}

function withAliases(boardId, pins) {
  const out = [];
  for (const pin of pins) {
    const ep = `${boardId}:${pin}`;
    out.push(...endpointAliases(ep));
  }
  return Array.from(new Set(out));
}

export function getUartPinCandidates(boardType) {
  const t = String(boardType || '').toLowerCase();

  if (t.includes('esp32')) {
    return {
      tx: ['TX', 'TX0', 'U0TXD', 'GPIO1', '1', 'D1'],
      rx: ['RX', 'RX0', 'U0RXD', 'GPIO3', '3', 'D3', '0', 'D0'],
    };
  }

  if (t.includes('rp2040') || t.includes('pico')) {
    return PICO_UART_PINS;
  }

  if (t.includes('stm32')) {
    return {
      tx: ['TX', 'TX1', 'PA9', '1', 'D1'],
      rx: ['RX', 'RX1', 'PA10', '0', 'D0'],
    };
  }

  return UNO_UART_PINS;
}

export function getSoftwareSerialPinCandidates(boardType) {
  const t = String(boardType || '').toLowerCase();

  if (t.includes('esp32')) {
    // Common SoftwareSerial example defaults in simulator projects.
    return {
      tx: ['17', 'D17', 'GPIO17'],
      rx: ['16', 'D16', 'GPIO16'],
    };
  }

  if (t.includes('rp2040') || t.includes('pico')) {
    return PICO_SOFTSERIAL_PINS;
  }

  if (t.includes('stm32')) {
    return {
      tx: ['10', 'D10', 'PB10'],
      rx: ['11', 'D11', 'PB11'],
    };
  }

  // Arduino UNO / default: SoftwareSerial(11,10) => RX=11, TX=10
  return UNO_SOFTSERIAL_PINS;
}

export function areBoardsUartConnected(sourceBoardId, sourceType, targetBoardId, targetType, areConnected) {
  const source = getUartPinCandidates(sourceType);
  const target = getUartPinCandidates(targetType);

  const sourceEndpoints = withAliases(sourceBoardId, source.tx);
  const targetEndpoints = withAliases(targetBoardId, target.rx);

  for (const src of sourceEndpoints) {
    for (const dst of targetEndpoints) {
      if (areConnected(src, dst)) {
        return true;
      }
    }
  }
  return false;
}

export function areBoardsSoftSerialConnected(sourceBoardId, sourceType, targetBoardId, targetType, areConnected) {
  const source = getSoftwareSerialPinCandidates(sourceType);
  const target = getSoftwareSerialPinCandidates(targetType);

  const sourceEndpoints = withAliases(sourceBoardId, source.tx);
  const targetEndpoints = withAliases(targetBoardId, target.rx);

  for (const src of sourceEndpoints) {
    for (const dst of targetEndpoints) {
      if (areConnected(src, dst)) {
        return true;
      }
    }
  }
  return false;
}
