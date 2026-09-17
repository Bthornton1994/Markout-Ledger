import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Fixture, parseFixture, serializeFixture } from './events.js';

export function loadFixture(path: string): Fixture {
  return parseFixture(readFileSync(path, 'utf8'));
}

export function saveFixture(path: string, fixture: Fixture): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeFixture(fixture), 'utf8');
}
