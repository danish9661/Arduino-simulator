export const PICO_GPIO_PINS = Array.from({ length: 29 }, (_, idx) => `GP${idx}`);

export const PICO_POWER_PINS = [
  'VBUS',
  'VSYS',
  '3V3',
  '3V3_EN',
  'ADC_VREF',
  'RUN',
  'AGND',
  'GND',
  'GND_1',
  'GND_2',
  'GND_3',
  'GND_4',
  'GND_5',
  'GND_6',
];

export const PICO_BOARD_PINS = [...PICO_GPIO_PINS, ...PICO_POWER_PINS];

export const PICO_UART_PINS = {
  tx: ['TX', 'TX0', 'GP0', 'GPIO0', '0', 'D0'],
  rx: ['RX', 'RX0', 'GP1', 'GPIO1', '1', 'D1'],
};

export const PICO_SOFTSERIAL_PINS = {
  tx: ['GP10', 'GPIO10', '10', 'D10'],
  rx: ['GP11', 'GPIO11', '11', 'D11'],
};

export const PICO_PLOTTER_PINS = [...PICO_GPIO_PINS];
