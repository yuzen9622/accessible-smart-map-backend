/** Public, stable categories; never expose rejected input or Zod's nested issues. */
export const VALIDATION_CODES = {
  invalid_type: "VALIDATION_INVALID_TYPE",
  too_small: "VALIDATION_TOO_SMALL",
  too_big: "VALIDATION_TOO_BIG",
  invalid_format: "VALIDATION_INVALID_FORMAT",
  invalid_value: "VALIDATION_INVALID_VALUE",
  unrecognized_keys: "VALIDATION_UNRECOGNIZED_KEYS",
  not_multiple_of: "VALIDATION_NOT_MULTIPLE_OF",
  invalid_union: "VALIDATION_INVALID_UNION",
  custom: "VALIDATION_CUSTOM",
  invalid: "VALIDATION_INVALID",
} as const;
