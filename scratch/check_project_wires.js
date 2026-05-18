const fs = require('fs');

const filePath = 'C:/Users/Danish/Documents/simulator/workflow/Wokwi_Project_by_Uri_Shaked_5.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

console.log('connections type:', typeof data.connections);
console.log('connections isArray:', Array.isArray(data.connections));
console.log('First 5 connections:', data.connections.slice(0, 5));
