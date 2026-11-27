export function issueNickname({ title, nickname }) {
  if (typeof nickname === 'string' && nickname.trim()) return nickname;
  const words = title.trim().replace(/\s+/gu, ' ');
  if (!/^.{49}/u.test(words)) return words;
  const [prefix] = words.match(/^.{32,47}(?= )|^.{47}/u);
  return prefix.trimEnd() + '…';
}
