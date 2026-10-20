// Only published response text. Provider reasoning/thinking blocks are private.
export function publishedModelText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        block &&
        typeof block === "object" &&
        ["text", "output_text"].includes(block.type) &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}
