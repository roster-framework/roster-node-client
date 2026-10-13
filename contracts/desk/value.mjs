export const bytes = (value) => new TextEncoder().encode(value).length;
export const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const equal = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const record = (value, keys, label) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw Error("Invalid " + label);
};
export const version = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw Error("Invalid " + label + " version");
};
export const id = (value, label, owner = false) => {
  if (
    typeof value !== "string" ||
    (!(owner && value === "$owner") && !identifier.test(value))
  )
    throw Error("Invalid " + label);
};
export function ids(values, label, max = 64, owner = false) {
  if (
    !Array.isArray(values) ||
    values.length > max ||
    new Set(values).size !== values.length
  )
    throw Error("Invalid " + label);
  values.forEach((value) => id(value, label, owner));
}
export function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || bytes(value) > max)
    throw Error("Invalid " + label);
}
