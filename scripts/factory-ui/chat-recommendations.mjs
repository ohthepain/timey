const maximumPrompts = 4;

export const nextPromptInstructions =
  'After the reply, suggest the next prompts that would help with this conversation. Use the latest outcome, decisions already made, unresolved questions and available actions or skills. Offer one clear next step, up to four genuinely distinct options, or an empty list when nothing remains. Give each a concise label and a self-contained prompt the person can choose to send. Never suggest an action the person ruled out or an action or skill unavailable here. Name any required tool in tool, any required skill in skill, and include issueId and action when invoking issue_control. Preserve required confirmation and approval.';

function promptText(value, length) {
  return typeof value === 'string' ? value.trim().slice(0, length) : '';
}

function available(entry, { skills, tools, allowsIssueAction }) {
  if (![undefined, null, ...skills].includes(entry.skill)) return false;
  if (![undefined, null, ...tools].includes(entry.tool)) return false;
  return entry.tool !== 'issue_control' || allowsIssueAction(entry);
}

function distinct(options, label, prompt) {
  return label && prompt && !options.some((option) => option.label === label || option.prompt === prompt);
}

function matchingEntries(value, capabilities) {
  return Array.isArray(value) ? value.filter(Boolean).filter((entry) => available(entry, capabilities)) : [];
}

export function normalizeChatRecommendations(value, capabilities = { skills: [], tools: [] }) {
  const options = [];
  for (const entry of matchingEntries(value, capabilities)) {
    const label = promptText(entry.label, 40);
    const prompt = promptText(entry.prompt, 2000);
    if (distinct(options, label, prompt)) options.push({ id: 'context-' + options.length, label, prompt });
    if (options.length === maximumPrompts) break;
  }
  return options;
}
