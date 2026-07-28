/**
 * Serialize every shared fixture's SchematicDocument to the schema-conformant
 * JSON form and print a JSON array to stdout. Consumed by the Python schema
 * validator in scripts/schematic-document-schema-validate.py.
 *
 * Run:  npx tsx scripts/schematic-document-serialize.ts
 */
import { createSchematicDocument, serializeSchematicDocument } from '../renderer/src/schematic/schematicDocument';
import { fixtures } from './lib/schematic-fixtures';

const docs = fixtures.map((fixture) => {
  const document = createSchematicDocument(fixture);
  return serializeSchematicDocument(document);
});
process.stdout.write(JSON.stringify(docs));
