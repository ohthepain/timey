// Capture has already durably saved every report before this explicit opt-in
// starts a conversation. Stable message IDs deduplicate retries and restarts.
export async function startCaptureGrilling(service, input, result) {
  const grilling = [];
  for (const issue of result.issues) {
    try {
      const sent = await service.issueChats.send({
        issueId: issue.id,
        id: 'capture-grill-' + input.requestId,
        mode: 'comment',
        text: 'I selected Grill me after creation. Grill me about this issue now. Read the saved issue and available context, then ask the current round of useful questions with recommended answers. Use my answers to sharpen the intended outcome and scope; avoid questions you can answer yourself. Keep this in the issue conversation. This requests discussion only, not implementation or plan approval.',
      });
      grilling.push({ issueId: issue.id, started: true, repeated: sent.repeated === true });
    } catch (error) {
      grilling.push({ issueId: issue.id, started: false, error: error.message });
    }
  }
  return { ...result, grilling };
}
