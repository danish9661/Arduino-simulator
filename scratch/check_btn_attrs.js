const fs = require('fs');

const filePath = 'C:/Users/Danish/Documents/simulator/workflow/Wokwi_Project_by_Uri_Shaked_5.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

data.components.forEach(c => {
    if (c.id.startsWith('btn')) {
        console.log(`Component id: ${c.id}`);
        console.log(`  type: ${c.type}`);
        console.log(`  attrs: ${JSON.stringify(c.attrs)}`);
    }
});
