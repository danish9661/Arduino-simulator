const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            if (file !== 'node_modules' && file !== '.git') {
                results = results.concat(walk(fullPath));
            }
        } else if (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.json')) {
            results.push(fullPath);
        }
    });
    return results;
}

const files = walk('C:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src');
files.forEach(f => {
    const content = fs.readFileSync(f, 'utf8');
    if (content.includes('openhw-arduino-uno') && (content.includes('pins') || content.includes('PIN_MAP'))) {
        console.log(`Found: ${f}`);
    }
});
