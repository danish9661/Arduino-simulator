import * as z from 'zod/v4';
import { isZ4Schema } from '../openhw-studio-cli/node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js';
import { CallToolResultSchema } from '../openhw-studio-cli/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

console.log('CallToolResultSchema:', CallToolResultSchema);
console.log('isZ4Schema(CallToolResultSchema):', isZ4Schema(CallToolResultSchema));
console.log('keys of CallToolResultSchema:', Object.keys(CallToolResultSchema));
console.log('_zod in CallToolResultSchema:', '_zod' in CallToolResultSchema);
console.log('type of CallToolResultSchema.safeParse:', typeof CallToolResultSchema.safeParse);
