import { randomUUID } from 'node:crypto';

export function createIssueDiscussion(service, session) {
  return {
    async begin() {},
    ask(text, skills = [], outputSchema, { generated = false } = {}) {
      return service.issueChats.request({
        issueId: session.issueId,
        id: 'discussion-' + randomUUID(),
        text,
        skills: skills.map((skill) => skill.name),
        stageContext: session.grilling || null,
        outputSchema,
        generated,
      });
    },
    close() {},
  };
}
