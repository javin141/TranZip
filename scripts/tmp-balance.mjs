// Temporary brace/paren balance scanner (deleted before hand-off).
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
const lines = (await readFile(file, 'utf8')).split('\n');
let depth = { '{': 0, '(': 0 };
let inTemplate = false;
lines.forEach((line, index) => {
  const stripped = line.replace(/\/\/.*$/, '');
  let curly = 0; let paren = 0;
  for (let i = 0; i < stripped.length; i += 1) {
    const char = stripped[i];
    if (char === '`') inTemplate = !inTemplate;
    if (inTemplate) continue;
    if (char === '{') curly += 1;
    if (char === '}') curly -= 1;
    if (char === '(') paren += 1;
    if (char === ')') paren -= 1;
  }
  depth['{'] += curly;
  depth['('] += paren;
  const marker = depth['{'] !== 0 || depth['('] !== 0 ? '' : '';
  if (index % 1 === 0 && (depth['{'] < 0 || depth['('] < 0 || marker)) {
    console.log(`NEGATIVE at line ${index + 1}: {}${depth['{']} ()${depth['(']} :: ${line.trim().slice(0, 70)}`);
  }
});
console.log('final depth', JSON.stringify(depth), 'lines', lines.length);
if (depth['{'] !== 0 || depth['('] !== 0) {
  let curly = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index].replace(/\/\/.*$/, '');
    for (const char of stripped) { if (char === '{') curly += 1; if (char === '}') curly -= 1; }
    if (/^(export |function |async function |const |let |\/\*)/.test(lines[index].trim()) && curly !== 0) {
      console.log(`depth ${curly} before top-level construct at line ${index + 1}: ${lines[index].trim().slice(0, 70)}`);
    }
  }
}