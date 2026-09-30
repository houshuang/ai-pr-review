import { parse } from "diff2html";

const string = { type: "string" };
const array = (items) => ({ type: "array", items });
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const file = object({ path: string, description: string, is_new: { type: "boolean" } });
const section = object({
  id: string, title: string, narrative: string, diagram: nullable(string),
  hunks: array(object({
    file: string, startLine: { type: "integer", minimum: 0 }, endLine: { type: "integer", minimum: 0 },
    annotation: string, importance: { type: "string", enum: ["critical", "important", "supporting", "context"] },
  })),
  callouts: array(object({ type: { type: "string", enum: ["insight", "warning", "pattern", "tradeoff", "question"] }, label: string, text: string })),
});

export const WALKTHROUGH_SCHEMA = object({
  title: string, subtitle: string, overview: string, architecture_diagram: string,
  sections: array(section), file_map: array(file), review_tips: array(string),
});

export const PATCH_SCHEMA = object({
  updated_sections: array(object({ id: string, section })), added_sections: array(section),
  removed_section_ids: array(string),
  file_map_changes: object({ added: array(file), removed: array(string), updated: array(file) }),
  architecture_diagram: nullable(string), title: nullable(string), subtitle: nullable(string), overview: nullable(string),
  review_tips: array(string),
});

export const VERDICT_SCHEMA = object({ status: { type: "string", enum: ["verified", "concern", "info"] }, finding: string });

export function assertSchema(value, schema, path = "response") {
  if (schema.anyOf) {
    for (const candidate of schema.anyOf) {
      try { assertSchema(value, candidate, path); return; } catch {}
    }
    throw new Error(`${path}: invalid value`);
  }
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type === "integer" ? !Number.isInteger(value) : type !== schema.type) throw new Error(`${path}: expected ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid enum value`);
  if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path}: below minimum`);
  if (schema.type === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (!schema.properties[key]) throw new Error(`${path}.${key}: unknown field`);
      assertSchema(item, schema.properties[key], `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    value.forEach((item, index) => assertSchema(item, schema.items, `${path}[${index}]`));
  }
}

export function diffInventory(diff) {
  return parse(diff).map((file) => ({
    path: file.isDeleted ? file.oldName : file.newName,
    isNew: Boolean(file.isNew), isDeleted: Boolean(file.isDeleted),
    ranges: file.blocks.map((block) => {
      const numbers = block.lines.map((line) => file.isDeleted ? line.oldNumber : line.newNumber).filter(Number.isInteger);
      return { start: numbers.length ? Math.min(...numbers) : block.newStartLine, end: numbers.length ? Math.max(...numbers) : block.newStartLine };
    }),
  }));
}

export function validateWalkthrough(walkthrough, diff) {
  const plain = { ...walkthrough, review_tips: (walkthrough.review_tips || []).map((tip) => typeof tip === "string" ? tip : tip.tip) };
  assertSchema(plain, WALKTHROUGH_SCHEMA);
  const files = diffInventory(diff);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const ids = new Set();
  for (const section of walkthrough.sections) {
    if (!section.id || ids.has(section.id)) throw new Error(`Duplicate or empty section id: ${section.id}`);
    ids.add(section.id);
    for (const hunk of section.hunks) {
      const file = byPath.get(hunk.file);
      if (!file) throw new Error(`Unknown hunk file: ${hunk.file}`);
      const contains = (line) => file.ranges.some((range) => line >= range.start && line <= range.end);
      if (hunk.startLine > hunk.endLine || !contains(hunk.startLine) || !contains(hunk.endLine)) {
        throw new Error(`Hunk range outside diff: ${hunk.file}:${hunk.startLine}-${hunk.endLine}`);
      }
    }
  }
  const descriptions = new Map();
  for (const entry of walkthrough.file_map) {
    if (!byPath.has(entry.path) || descriptions.has(entry.path)) throw new Error(`Unknown or duplicate file_map path: ${entry.path}`);
    descriptions.set(entry.path, entry.description);
  }
  // Coverage comes from the diff; the model supplies descriptions where it has context.
  walkthrough.file_map = files.map((file) => ({ path: file.path, is_new: file.isNew, description: descriptions.get(file.path) || "Not included in the narrated sections; inspect the diff in Remaining Changes." }));
  return walkthrough;
}

export function validatePatch(patch, previous) {
  assertSchema(patch, PATCH_SCHEMA);
  const ids = new Set(previous.sections.map((section) => section.id));
  const changes = new Set();
  for (const update of patch.updated_sections) {
    if (!ids.has(update.id) || update.id !== update.section.id || changes.has(update.id)) throw new Error(`Invalid updated section: ${update.id}`);
    changes.add(update.id);
  }
  for (const id of patch.removed_section_ids) {
    if (!ids.has(id) || changes.has(id)) throw new Error(`Invalid removed section: ${id}`);
    changes.add(id);
  }
  for (const section of patch.added_sections) {
    if (ids.has(section.id) || changes.has(section.id)) throw new Error(`Invalid added section: ${section.id}`);
    changes.add(section.id);
  }
  return patch;
}
