import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const skills = ["keiyaku", "keiyaku-task", "keiyaku-bind", "keiyaku-workflow", "keiyaku-akuma"]
  .map((name) => fileURLToPath(new URL(`./skills/${name}/SKILL.md`, import.meta.url)));

export default {
  id: "keiyaku-v4",
  server: async () => ({
    config: async (config) => {
      const instructions = config.instructions ?? (config.instructions = []);
      await Promise.all(skills.map((skill) => readFile(skill, "utf8")));
      for (const skill of skills) if (!instructions.includes(skill)) instructions.push(skill);
    },
  }),
};
