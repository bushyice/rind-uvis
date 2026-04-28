const fs = require('fs');
const path = require('path');

// Simple TOML-ish parser for the sync script
function parse(text) {
  const result = {};
  let currentArr = null;
  let currentObj = null;
  text.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('[[')) {
      const key = line.slice(2, -2).trim();
      result[key] = result[key] || [];
      currentObj = {};
      result[key].push(currentObj);
    } else if (line.includes('=')) {
      const [k, ...v] = line.split('=');
      const val = v.join('=').trim().replace(/^"|"$/g, '');
      if (currentObj) currentObj[k.trim()] = val;
    }
  });
  return result;
}

const unitsDir = './units';
const units = {};
const files = fs.readdirSync(unitsDir).filter(f => f.endsWith('.toml'));

files.forEach(file => {
  const content = fs.readFileSync(path.join(unitsDir, file), 'utf8');
  units[file.replace('.toml', '')] = parse(content);
});

const tsContent = \`
import { UnitComponent } from './models';

export const UNITS: Record<string, any> = \${JSON.stringify(units, null, 2)};
\`;

fs.writeFileSync('./src/units_data.ts', tsContent);
console.log('Synchronized ' + files.length + ' units to src/units_data.ts');
