export {
  parseDesk,
  formatDesk,
  planDesk,
  applyDesk,
  exportDesk,
} from "./agent.mjs";
export {
  parseWorkspaceDesk,
  formatWorkspaceDesk,
  validateWorkspaceDesk,
} from "./workspace-format.mjs";
export {
  planWorkspaceDesk,
  applyWorkspaceDesk,
  exportWorkspaceDesk,
  DeskApplyError,
} from "./workspace.mjs";
import { parseDesk } from "./agent.mjs";
import { parseWorkspaceDesk } from "./workspace-format.mjs";
import { bytes } from "./value.mjs";
import {parseDeskJSON} from './json.mjs';
export function parseDeskDocument(source) {
  if (bytes(source) > 250000)
    throw Error("Workspace Desk exceeds 250000 bytes");
  const match = source
    .replace(/^\uFEFF/, "")
    .match(/^```json\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)/);
  if (!match)
    throw Error(
      "Desk must start with a JSON fenced block followed by Markdown instructions",
    );
  return parseDeskJSON(match[1],250000)?.schema === "roster/desk/v2"
    ? parseWorkspaceDesk(source)
    : parseDesk(source);
}
