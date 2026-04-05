const DEFAULT_BACKEND_URL = 'http://localhost:5001/api';

function stripTrailingSlash(input: string): string {
  return String(input || '').replace(/\/+$/, '') || DEFAULT_BACKEND_URL;
}

function buildUrl(baseUrl: string, relativePath: string): string {
  const cleanBase = stripTrailingSlash(baseUrl);
  const cleanPath = String(relativePath || '').replace(/^\/+/, '');
  return `${cleanBase}/${cleanPath}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    const errMsg = (parsed as any)?.error || (parsed as any)?.message || `HTTP ${response.status}`;
    throw new Error(String(errMsg));
  }

  return parsed as T;
}

export async function compileCode(
  baseUrl: string,
  payload: {
    code?: string;
    files?: Array<{ name: string; content: string }>;
    sketchName?: string;
    fqbn?: string;
    builder?: string;
  }
): Promise<any> {
  const response = await fetch(buildUrl(baseUrl, 'compile'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseResponse<any>(response);
}

export async function fetchDefaultPicoMicroPythonUf2(baseUrl: string): Promise<Buffer> {
  const response = await fetch(buildUrl(baseUrl, 'compile/pico/micropython-uf2'));
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Failed to fetch default Pico UF2 (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function listBackendPorts(baseUrl: string, showAll = false): Promise<any[]> {
  const url = new URL(buildUrl(baseUrl, 'compile/ports'));
  if (showAll) {
    url.searchParams.set('showAll', 'true');
  }
  const response = await fetch(url.toString());
  const data = await parseResponse<{ ports?: any[] }>(response);
  return data.ports || [];
}

export async function listLibraries(baseUrl: string): Promise<any[]> {
  const response = await fetch(buildUrl(baseUrl, 'lib-list'));
  const data = await parseResponse<{ libraries?: any[] }>(response);
  return data.libraries || [];
}

export async function searchLibraries(baseUrl: string, query: string): Promise<any[]> {
  const url = new URL(buildUrl(baseUrl, 'lib-search'));
  url.searchParams.set('q', query);
  const response = await fetch(url.toString());
  const data = await parseResponse<{ libraries?: any[] }>(response);
  return data.libraries || [];
}

export async function installLibrary(baseUrl: string, name: string): Promise<any> {
  const response = await fetch(buildUrl(baseUrl, 'lib-install'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return parseResponse<any>(response);
}

export async function uninstallLibrary(baseUrl: string, name: string): Promise<any> {
  const response = await fetch(buildUrl(baseUrl, 'lib-uninstall'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return parseResponse<any>(response);
}

export { DEFAULT_BACKEND_URL };
