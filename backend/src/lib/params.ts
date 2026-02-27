// Express 5 types req.params values as string | string[]
// This helper safely extracts a single string param
export function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0];
  return value || '';
}
