import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ManagedAgentConfig } from "@roster/contracts";

const skillId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const maxSkillBytes = 30_000;
const maxTotalBytes = 100_000;

export async function managedSkillCatalog() {
  const directory = process.env.ROSTER_SKILLS_DIR;
  if (!directory) return { mode: "references" as const, skills: [] };
  try {
    const root = await realpath(resolve(directory));
    const names = (await readdir(root)).filter(name => skillId.test(name)).sort();
    const scanned = await Promise.all(names.slice(0, 200).map(async id => {
      try {
        const file = await realpath(join(root, id, "SKILL.md"));
        if (!file.startsWith(root + sep)) return { id, ready: false };
        const metadata = await stat(file);
        return { id, ready: metadata.isFile() && metadata.size <= maxSkillBytes };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        return { id, ready: false };
      }
    }));
    const skills = scanned.filter(item => item !== null);
    return { mode: "files" as const, skills, truncated: names.length > 200 };
  } catch {
    // A missing catalog must not lock an operator out of runtime administration.
    return { mode: "files" as const, skills: [], error: "스킬 폴더를 읽을 수 없습니다." };
  }
}

export async function managedSkillsPrompt(ids: string[]): Promise<string> {
  if (!ids.length) return "";
  const directory = process.env.ROSTER_SKILLS_DIR;
  // Existing deployments treated skills as references. Keep that behavior until
  // their operator explicitly enables the file-backed catalog.
  if (!directory) return `\n스킬 참조(본문 미설정): ${ids.join(", ")}`;
  if (ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => !skillId.test(id)))
    throw Error("스킬은 중복 없는 ID 20개 이내로 지정하세요.");
  const root = await realpath(resolve(directory));
  const entries: string[] = [];
  let total = 0;
  for (const id of ids) {
    const file = await realpath(join(root, id, "SKILL.md"));
    if (!file.startsWith(root + sep)) throw Error(`스킬이 지정 폴더 밖을 참조합니다: ${id}`);
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > maxSkillBytes)
      throw Error(`스킬 파일 크기를 확인하세요: ${id}`);
    const body = await readFile(file, "utf8");
    const bytes = Buffer.byteLength(body);
    if (bytes > maxSkillBytes) throw Error(`스킬 파일 크기를 확인하세요: ${id}`);
    total += bytes;
    if (total > maxTotalBytes) throw Error("스킬 본문 합계가 100KB를 넘습니다.");
    entries.push(`<skill id="${id}">\n${body}\n</skill>`);
  }
  return `\n선택한 런타임 스킬:\n${entries.join("\n")}`;
}

export async function validateManagedAgentSkills(config: ManagedAgentConfig, previous?: ManagedAgentConfig) {
  if (config.kind !== "llm") return;
  if (previous?.kind === "llm" && JSON.stringify(previous.skills) === JSON.stringify(config.skills)) return;
  await managedSkillsPrompt(config.skills);
}
