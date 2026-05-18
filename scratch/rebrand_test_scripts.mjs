import fs from 'node:fs';
import path from 'node:path';

const files = [
  'validate_8x_fix.mjs',
  'uno_pico.mjs',
  'uart_test.mjs',
  'test_script.mjs',
  'test_lcd_debug.mjs',
  'simple_test.mjs',
  'pico_pico.mjs',
  'pico_peripherals.mjs'
];

for (const file of files) {
  const filePath = path.join(process.cwd(), file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/wokwi-/g, 'openhw-');
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated ${file}`);
  }
}
