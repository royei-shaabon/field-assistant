// npm run kb:validate — exits 1 if the knowledge base breaks any rule.
import path from "node:path";
import { validateKnowledgeBase } from "../lib/kb-validate";

const kbDir = path.resolve(process.argv[2] ?? "knowledge");
const { errors, warnings, symptomCount, tipCount } = validateKnowledgeBase(kbDir);

for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);

if (errors.length) {
  console.error(`\nkb:validate FAILED: ${errors.length} error(s)`);
  process.exit(1);
}
console.log(`kb:validate OK: ${symptomCount} symptom(s), ${tipCount} tip(s), ${warnings.length} warning(s)`);
