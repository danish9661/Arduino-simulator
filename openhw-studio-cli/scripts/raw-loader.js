import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('?raw')) {
    const baseSpecifier = specifier.split('?')[0];
    const resolved = await nextResolve(baseSpecifier, context);
    return {
      ...resolved,
      url: resolved.url + '?raw'
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.includes('?raw')) {
    const filePath = fileURLToPath(url.split('?')[0]);
    const content = await fs.readFile(filePath, 'utf8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(content)};`
    };
  }
  return nextLoad(url, context);
}
