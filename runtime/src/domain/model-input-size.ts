// Byte accounting is a diagnostic of constructed inputs, not billed tokens or
// the SDK's complete request envelope. Return counters only, never the source.
export function modelInputSizes(parts: Record<string,unknown>): Record<string,number> {
  const encoder=new TextEncoder(),sizes:Record<string,number>={};
  for(const [name,value] of Object.entries(parts))sizes[name]=encoder.encode(typeof value==="string" ? value : JSON.stringify(value)??"").length;
  return sizes;
}
