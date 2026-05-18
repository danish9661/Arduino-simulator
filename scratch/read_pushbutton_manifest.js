const fs = require('fs');
const path = require('path');

// Let's find any manifest file under openhw-pushbutton
const dir = 'C:/Users/Danish/Documents/simulator/openhw-studio-emulator/src/components/openhw-pushbutton';
const files = fs.readdirSync(dir);
console.log('Files in openhw-pushbutton:', files);
files.forEach(file => {
    if (file.endsWith('.json') || file.includes('manifest')) {
        console.log(`--- ${file} ---`);
        console.log(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
});
