const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            results = results.concat(walk(fullPath));
        } else if (file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.ts') || file.endsWith('.tsx')) {
            results.push(fullPath);
        }
    });
    return results;
}

const files = walk('C:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src');
files.forEach(file => {
    if (path.basename(file).toLowerCase().includes('shortcut')) {
        console.log(`Found: ${file}`);
    }
});
