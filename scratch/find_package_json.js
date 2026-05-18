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
        } else if (file === 'package.json') {
            results.push(fullPath);
        }
    });
    return results;
}

const files = walk('C:/Users/Danish/Documents/simulator');
files.forEach(f => {
    console.log(f);
    const content = JSON.parse(fs.readFileSync(f, 'utf8'));
    console.log('  scripts:', Object.keys(content.scripts || {}));
});
