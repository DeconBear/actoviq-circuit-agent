/**
 * Scratch probe: render a real module.circuit.json through the TS projection and
 * report component positions plus estimated label/body overlaps.
 * Run: npx tsx scripts/probe-layout-overlap.ts <module.circuit.json>
 */
import { readFileSync } from 'node:fs';
import { createSchematicDocument } from '../renderer/src/schematic/schematicDocument';
import type { CircuitComponent, CircuitModule } from '../renderer/src/types';

const CHAR_W_NAME = 9; // 17px Arial bold-ish
const CHAR_W_VALUE = 7.5; // 15px Arial

function displayValue(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  if (text.length <= 22) return text;
  if (/^PULSE\s*\(/i.test(text)) return 'PULSE(...)';
  if (/^PWL\s*\(/i.test(text)) return 'PWL(...)';
  if (/^SIN\s*\(/i.test(text)) return 'SIN(...)';
  if (/^EXP\s*\(/i.test(text)) return 'EXP(...)';
  return `${text.slice(0, 20)}…`;
}

interface Box { left: number; right: number; top: number; bottom: number; tag: string }

function labelBoxes(component: CircuitComponent): Box[] {
  const { x, y } = component.position;
  const rotation = ((component.rotation ?? 0) % 360 + 360) % 360;
  const isVerticalTwoPin = component.pins.length === 2 && (rotation === 90 || rotation === 270);
  const name = component.name;
  const value = displayValue(component.value);
  const boxes: Box[] = [];
  const push = (px: number, py: number, anchor: string, text: string, cw: number, tag: string) => {
    if (!text) return;
    const w = text.length * cw;
    const left = anchor === 'end' ? px - w : anchor === 'middle' ? px - w / 2 : px;
    // SVG text y is the baseline; glyph ink spans roughly -12..+2 around it.
    boxes.push({ left, right: left + w, top: py - 12, bottom: py + 2, tag: `${component.name}.${tag}="${text}"` });
  };
  if (isVerticalTwoPin) {
    push(x - 46, y - 28, 'end', name, CHAR_W_NAME, 'name');
    push(x - 46, y - 6, 'end', value, CHAR_W_VALUE, 'value');
    return boxes;
  }
  if (component.type === 'M') {
    push(x, y - 66, 'middle', name, CHAR_W_NAME, 'name');
    push(x + 52, y + 8, 'start', value, CHAR_W_VALUE, 'value');
    return boxes;
  }
  push(x, y - 42, 'middle', name, CHAR_W_NAME, 'name');
  push(x, y + 44, 'middle', value, CHAR_W_VALUE, 'value');
  return boxes;
}

function bodyBox(component: CircuitComponent): Box {
  const { x, y } = component.position;
  const rotation = ((component.rotation ?? 0) % 360 + 360) % 360;
  if (component.type === 'M' || component.type === 'Q') {
    return { left: x - 58, right: x + 58, top: y - 52, bottom: y + 52, tag: `${component.name}.body` };
  }
  if (component.pins.length === 2) {
    // Symbol art only (leads excluded): vertical art is ~x±12/y±26, horizontal ~x±26/y±12.
    const vertical = rotation === 90 || rotation === 270;
    return vertical
      ? { left: x - 12, right: x + 12, top: y - 26, bottom: y + 26, tag: `${component.name}.body` }
      : { left: x - 26, right: x + 26, top: y - 12, bottom: y + 12, tag: `${component.name}.body` };
  }
  return { left: x - 30, right: x + 30, top: y - 30, bottom: y + 30, tag: `${component.name}.body` };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

const file = process.argv[2];
if (!file) throw new Error('usage: probe-layout-overlap.ts <module.circuit.json>');
const moduleData = JSON.parse(readFileSync(file, 'utf8')) as CircuitModule;
const document = createSchematicDocument(moduleData);

console.log('== positions ==');
for (const component of document.module.components) {
  console.log(
    `${component.name.padEnd(6)} type=${component.type.padEnd(2)} pos=(${component.position.x},${component.position.y}) rot=${component.rotation ?? 0}`,
  );
}

const boxes: Box[] = [];
for (const component of document.module.components) {
  boxes.push(...labelBoxes(component));
  boxes.push(bodyBox(component));
}
let collisions = 0;
for (let i = 0; i < boxes.length; i += 1) {
  for (let j = i + 1; j < boxes.length; j += 1) {
    const a = boxes[i];
    const b = boxes[j];
    if (!overlaps(a, b)) continue;
    if (a.tag.startsWith(b.tag.split('.')[0] + '.') && b.tag.startsWith(a.tag.split('.')[0] + '.')) continue; // same owner
    const labelInvolved = !a.tag.endsWith('.body') || !b.tag.endsWith('.body');
    if (!labelInvolved) continue;
    collisions += 1;
    console.log(`OVERLAP  ${a.tag}  <->  ${b.tag}`);
  }
}
console.log(`== ${collisions} label collisions ==`);

console.log('== wires ==');
for (const wire of document.wires) {
  const points = (wire.points ?? []).map((point) => `${point.x},${point.y}`).join(' -> ');
  console.log(`${wire.id} net=${wire.net} ${points}`);
}
