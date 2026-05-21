import * as z4mini from 'zod/v4-mini';
import { CallToolResultSchema } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

console.log('z4mini keys:', Object.keys(z4mini));
console.log('type of z4mini.safeParse:', typeof z4mini.safeParse);
console.log('z4mini.safeParse:', z4mini.safeParse);
try {
  const res = z4mini.safeParse(CallToolResultSchema, { ok: true, content: [] });
  console.log('safeParse result:', res);
} catch (err) {
  console.error('safeParse failed:', err);
}
