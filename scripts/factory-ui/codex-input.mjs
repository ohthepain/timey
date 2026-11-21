export const maximumTextInputLength = 1048576;
export const oversizedTextInputMessage = `Input exceeds the maximum length of ${maximumTextInputLength} characters.`;

export function validateTextInput(prompt) {
  if (prompt.length > maximumTextInputLength)
    throw Object.assign(Error(oversizedTextInputMessage), { turnRejected: true });
}
