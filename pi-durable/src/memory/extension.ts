export function toolText(value: unknown) {
  return { output: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
