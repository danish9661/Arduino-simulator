import fs from 'node:fs';

async function main() {
  const jsonPath = '../workflow/Wokwi_Project_by_Uri_Shaked_6.json';
  const project = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  
  const uno1File = project.projectFiles.find(f => f.name === 'mini-piano.ino');
  const pitchesFile = project.projectFiles.find(f => f.name === 'pitches.h');
  
  const payload = {
    code: uno1File.content,
    files: [
      { name: 'mini-piano.ino', content: uno1File.content },
      { name: 'pitches.h', content: pitchesFile.content }
    ],
    sketchName: 'uno1',
    fqbn: 'arduino:avr:uno'
  };
  
  console.log('Sending compile request to http://localhost:5001/api/compile...');
  try {
    const res = await fetch('http://localhost:5001/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    console.log('Status:', res.status);
    const body = await res.json();
    console.log('Response:', JSON.stringify(body, null, 2));
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

main();
