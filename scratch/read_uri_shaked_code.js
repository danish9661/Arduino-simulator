const fs = require('fs');
const path = require('path');

const filePath = 'C:/Users/Danish/Documents/simulator/workflow/Wokwi_Project_by_Uri_Shaked_5.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

if (data.projectFiles) {
    console.log('ProjectFiles list:', Object.keys(data.projectFiles));
    for (const [key, file] of Object.entries(data.projectFiles)) {
        console.log(`- file key: ${key}`);
        console.log(`  name: ${file.name}`);
        console.log(`  content length: ${file.content?.length}`);
        if (file.name && (file.name.endsWith('.ino') || file.name.endsWith('.cpp') || file.name.endsWith('.h'))) {
            console.log('--- Content ---');
            console.log(file.content);
        }
    }
}
