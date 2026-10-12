/**
 * Minimal JSON Schema (draft-07 subset) evaluator.
 *
 * Mirrors schema/tool.schema.json's needs exactly, and deliberately nothing
 * more. The same subset is implemented in tools/validate_registry.py, so the
 * Python CI gate and this parser agree on what "valid" means.
 *
 * Supported: $ref (local), type, enum, const, properties,
 * additionalProperties, required, items, minItems, maxItems, uniqueItems,
 * minLength, maxLength, pattern, format (date, uri), minimum, maximum,
 * allOf, anyOf, oneOf, not, if/then/else, definitions, $defs.
 */

import { readFileSync } from 'node:fs';

const KNOWN_KEYWORDS = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples',
  'definitions', '$defs', 'type', 'enum', 'const', 'properties',
  'additionalProperties', 'required', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'minLength', 'maxLength', 'pattern', 'format', 'minimum',
  'maximum', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref',
]);

/**
 * @param {unknown} value
 * @param {string} expected
 * @returns {boolean}
 */
function typeMatches(value, expected) {
  switch (expected) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      throw new Error(`unsupported schema type: ${expected}`);
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const URI_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/\S+$/;

export class SchemaValidator {
  /**
   * @param {Record<string, unknown>} schema
   */
  constructor(schema) {
    this.root = schema;
    this.#assertSupported(schema, '#');
  }

  /** @param {string} path */
  static fromFile(path) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (cause) {
      throw new Error(`cannot read schema ${path}: ${cause.message}`);
    }
    return new SchemaValidator(JSON.parse(text));
  }

  #assertSupported(node, path) {
    if (Array.isArray(node)) {
      node.forEach((sub, i) => this.#assertSupported(sub, `${path}/${i}`));
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node)) {
      if (!KNOWN_KEYWORDS.has(key)) {
        throw new Error(`schema ${path}: unsupported keyword '${key}'`);
      }
      if (key === 'properties' || key === 'definitions' || key === '$defs') {
        for (const [subKey, sub] of Object.entries(value)) {
          this.#assertSupported(sub, `${path}/${key}/${subKey}`);
        }
      } else if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') {
        value.forEach((sub, i) => this.#assertSupported(sub, `${path}/${key}/${i}`));
      } else if (['items', 'not', 'if', 'then', 'else', 'additionalProperties'].includes(key)) {
        if (value !== null && typeof value === 'object') {
          this.#assertSupported(value, `${path}/${key}`);
        }
      }
    }
  }

  /** @param {string} ref */
  #resolve(ref) {
    if (!ref.startsWith('#/')) {
      throw new Error(`only local $ref is supported, got '${ref}'`);
    }
    return ref
      .slice(2)
      .split('/')
      .reduce((node, part) => node[part.replace(/~1/g, '/').replace(/~0/g, '~')], this.root);
  }

  /**
   * Validate a value, returning every problem found.
   *
   * @param {unknown} value
   * @param {Record<string, unknown>} [schema]
   * @param {string} [path]
   * @returns {string[]} human-readable problems, empty when valid
   */
  errors(value, schema = this.root, path = '$') {
    const out = [];

    if (schema.$ref !== undefined) {
      return this.errors(value, this.#resolve(String(schema.$ref)), path);
    }

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => typeMatches(value, t))) {
        return [`${path}: expected type ${types.join('|')}, got ${describe(value)}`];
      }
    }

    if (schema.const !== undefined && value !== schema.const) {
      out.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
    }

    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      out.push(`${path}: must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    }

    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        out.push(`${path}: shorter than ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        out.push(`${path}: longer than ${schema.maxLength} characters`);
      }
      if (schema.pattern !== undefined && !new RegExp(String(schema.pattern)).test(value)) {
        out.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
      }
      // Only formats this validator understands are enforced; a declared but
      // unsupported format must not silently become a failure.
      if (schema.format === 'date' && !DATE_PATTERN.test(value)) {
        out.push(`${path}: ${JSON.stringify(value)} is not an ISO date (YYYY-MM-DD)`);
      }
      if (schema.format === 'uri' && !URI_PATTERN.test(value)) {
        out.push(`${path}: ${JSON.stringify(value)} is not an absolute URI`);
      }
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      if (schema.minimum !== undefined && value < schema.minimum) {
        out.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        out.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
      }
    }

    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        out.push(`${path}: needs at least ${schema.minItems} item(s)`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        out.push(`${path}: allows at most ${schema.maxItems} item(s)`);
      }
      if (schema.uniqueItems === true) {
        const seen = new Set(value.map((v) => JSON.stringify(v)));
        if (seen.size !== value.length) out.push(`${path}: entries must be unique`);
      }
      if (schema.items !== undefined) {
        value.forEach((item, i) => out.push(...this.errors(item, schema.items, `${path}[${i}]`)));
      }
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          out.push(`${path}: missing required property '${key}'`);
        }
      }
      const props = schema.properties ?? {};
      for (const [key, sub] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          out.push(...this.errors(value[key], sub, `${path}.${key}`));
        }
      }
      const extra = schema.additionalProperties;
      if (extra === false) {
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(props, key)) {
            out.push(`${path}: unexpected property '${key}'`);
          }
        }
      } else if (extra !== null && typeof extra === 'object') {
        for (const [key, sub] of Object.entries(value)) {
          if (!Object.prototype.hasOwnProperty.call(props, key)) {
            out.push(...this.errors(sub, extra, `${path}.${key}`));
          }
        }
      }
    }

    for (const sub of schema.allOf ?? []) out.push(...this.errors(value, sub, path));

    if (Array.isArray(schema.anyOf)) {
      const hit = schema.anyOf.some((sub) => this.errors(value, sub, path).length === 0);
      if (!hit) out.push(`${path}: matches none of the allowed forms`);
    }

    if (Array.isArray(schema.oneOf)) {
      const hits = schema.oneOf.filter((sub) => this.errors(value, sub, path).length === 0).length;
      if (hits !== 1) out.push(`${path}: must match exactly one allowed form (matched ${hits})`);
    }

    if (schema.not !== undefined && this.errors(value, schema.not, path).length === 0) {
      out.push(`${path}: matches a forbidden form`);
    }

    if (schema.if !== undefined) {
      const branch = this.errors(value, schema.if, path).length === 0 ? 'then' : 'else';
      if (schema[branch] !== undefined) out.push(...this.errors(value, schema[branch], path));
    }

    return out;
  }

  /** @returns {boolean} */
  isValid(value) {
    return this.errors(value).length === 0;
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
