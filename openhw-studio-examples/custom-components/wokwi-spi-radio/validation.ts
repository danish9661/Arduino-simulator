export const validation = {
  rules: [
    {
      id: 'spi-radio-vcc-range',
      description: 'VCC should be in 2.7V-3.6V range for common low-voltage radios',
      check: (component, graph, validator) => {
        const vccNode = `${component.id}:VCC`;
        const v = validator.calculateVoltageAtNode(vccNode);
        if (v > 3.7) {
          return {
            pass: false,
            message: `SPI radio ${component.id}: VCC=${v.toFixed(2)}V is above 3.6V. Use level shifting or 3.3V supply.`
          };
        }
        return { pass: true };
      }
    },
    {
      id: 'spi-radio-csn-required',
      description: 'CSN should be wired for deterministic SPI transactions',
      check: (component, graph) => {
        const node = `${component.id}:CSN`;
        const hasWire = graph?.wires?.some((w) => w.from === node || w.to === node);
        if (!hasWire) {
          return {
            pass: false,
            message: `SPI radio ${component.id}: CSN pin is not wired. Wire CSN to a GPIO output and drive it LOW during SPI transfer.`
          };
        }
        return { pass: true };
      }
    }
  ]
};
