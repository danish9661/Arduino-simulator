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
        } else if (file.endsWith('.ts') || file.endsWith('.js')) {
            if (path.basename(file).toLowerCase().includes('basecomponent')) {
                results.push(fullPath);
            }
        }
    });
    return results;
}

const files = walk('C:/Users/Danish/Documents/simulator');
console.log('Found BaseComponent files:');
files.forEach(f => console.log(f));
