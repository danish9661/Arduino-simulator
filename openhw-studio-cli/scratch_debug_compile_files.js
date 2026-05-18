import fs from 'node:fs';
import { loadProject } from './src/utils/project.js';
import { getCompileFilesForBoard } from './src/utils/project.js';

async function main() {
  const project = await loadProject('../workflow/Wokwi_Project_by_Uri_Shaked_6.json');
  const files = getCompileFilesForBoard(project, 'uno1');
  console.log('Compile files for uno1:', JSON.stringify(files, null, 2));
}

main();
