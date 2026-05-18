const fs = require('fs');

const filePath = 'C:/Users/Danish/Documents/simulator/workflow/Wokwi_Project_by_Uri_Shaked_5.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

data.connections.forEach((w, idx) => {
    if (w.from.includes('btn') || w.to.includes('btn')) {
        console.log(`Wire ${idx}: id="${w.id || ''}", from="${w.from}", to="${w.to}"`);
    }
});
