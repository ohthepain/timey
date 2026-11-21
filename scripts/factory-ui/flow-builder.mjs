import { createDiscussionRuntime } from './discussion-codex.mjs';
import { listAvailableSkills, selectedSkills } from './skills.mjs';

const nodeSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    block: { type: 'string' },
    after: { type: 'array', items: { type: 'string' } },
    lane: { type: 'integer' },
    suggested: { type: 'boolean' },
  },
  required: ['id', 'block', 'after', 'lane', 'suggested'],
  additionalProperties: false,
};
const schema = {
  type: 'object',
  properties: { blocks: { type: 'array', items: nodeSchema } },
  required: ['blocks'],
  additionalProperties: false,
};

export async function buildFlowStructure({ service, issue, type, definition, catalog, request }) {
  const session = createDiscussionRuntime();
  let deadline;
  try {
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error('The flow builder timed out. Try again.')), 90_000);
    });
    const build = async () => {
      const skills = definition.skill
        ? selectedSkills(await listAvailableSkills(service.codex, service.root), [definition.skill])
        : [];
      await session.begin(
        { task: 'Build the proposed issue flow as structured data.' },
        `Return an ordered list of blocks. Keep Request as the first block with the key request. Starting point and Destination are supplied by the workspace. Use available block definitions and list dependencies before their successors. You may add, remove, or reorder other blocks. Preserve the keys of blocks you retain. This action only describes the flow structure.\n\n${definition.prompt}`
      );
      const output = await session.ask(
        JSON.stringify({
          issueType: type,
          request: request ?? { title: issue.title, wording: issue.content.slice(0, 24000) },
          blocks: definition.blocks,
          availableBlockDefinitions: catalog
            .filter((entry) => entry.usable && entry.kind !== 'verify')
            .map(({ id, label }) => ({ id, label })),
        }),
        skills,
        schema
      );
      return JSON.parse(output).blocks;
    };
    return await Promise.race([build(), timeout]);
  } finally {
    clearTimeout(deadline);
    session.close();
  }
}
