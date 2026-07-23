type Schema = Record<string, unknown>;

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`external schema ref forbidden: ${ref}`);
  let cursor: unknown = root;
  for (const token of ref.slice(2).split("/")) {
    if (cursor === null || typeof cursor !== "object") throw new Error(`invalid schema ref: ${ref}`);
    cursor = (cursor as Record<string, unknown>)[token.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (cursor === null || typeof cursor !== "object") throw new Error(`invalid schema ref: ${ref}`);
  return cursor as Schema;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateNode(value: unknown, schema: Schema, root: Schema, path: string, errors: string[]): void {
  if (typeof schema["$ref"] === "string") {
    validateNode(value, resolveRef(root, schema["$ref"]), root, path, errors);
    return;
  }
  if (Array.isArray(schema["allOf"])) {
    for (const child of schema["allOf"] as Schema[]) validateNode(value, child, root, path, errors);
  }
  if (Array.isArray(schema["anyOf"])) {
    const candidates = schema["anyOf"] as Schema[];
    if (!candidates.some((child) => {
      const candidateErrors: string[] = [];
      validateNode(value, child, root, path, candidateErrors);
      return candidateErrors.length === 0;
    })) errors.push(`${path}: no anyOf branch matched`);
    return;
  }
  if ("const" in schema && !equal(value, schema["const"])) errors.push(`${path}: const mismatch`);
  if (Array.isArray(schema["enum"]) && !(schema["enum"] as unknown[]).some((entry) => equal(value, entry))) {
    errors.push(`${path}: enum mismatch`);
  }
  const type = schema["type"];
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return;
    }
    const object = value as Record<string, unknown>;
    const properties = (schema["properties"] ?? {}) as Record<string, Schema>;
    for (const key of (schema["required"] ?? []) as string[]) {
      if (!(key in object)) errors.push(`${path}.${key}: required`);
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(object)) {
        if (!(key in properties)) errors.push(`${path}.${key}: additional property`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in object) validateNode(object[key], child, root, `${path}.${key}`, errors);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return;
    }
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) errors.push(`${path}: too few items`);
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) errors.push(`${path}: too many items`);
    const prefix = schema["prefixItems"];
    if (Array.isArray(prefix)) {
      (prefix as Schema[]).forEach((child, index) => {
        if (index < value.length) validateNode(value[index], child, root, `${path}[${index}]`, errors);
      });
      if (schema["items"] === false && value.length > prefix.length) errors.push(`${path}: extra items`);
    } else if (schema["items"] !== undefined && schema["items"] !== false) {
      value.forEach((entry, index) => validateNode(entry, schema["items"] as Schema, root, `${path}[${index}]`, errors));
    }
  } else if (type === "string") {
    if (typeof value !== "string") errors.push(`${path}: expected string`);
    else {
      if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) errors.push(`${path}: too short`);
      if (typeof schema["pattern"] === "string" && !(new RegExp(schema["pattern"])).test(value)) errors.push(`${path}: pattern mismatch`);
      if (schema["format"] === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path}: invalid date-time`);
    }
  } else if (type === "integer") {
    if (!Number.isInteger(value)) errors.push(`${path}: expected integer`);
    else if (typeof schema["minimum"] === "number" && (value as number) < schema["minimum"]) errors.push(`${path}: below minimum`);
  } else if (type === "boolean" && typeof value !== "boolean") errors.push(`${path}: expected boolean`);
  else if (type === "null" && value !== null) errors.push(`${path}: expected null`);
}

export function validateAgainstSchema(value: unknown, schema: Schema): readonly string[] {
  const errors: string[] = [];
  validateNode(value, schema, schema, "$", errors);
  return Object.freeze(errors);
}
