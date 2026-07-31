/**
 * Mock job handler for the rate-limited-queue example: simulates a slow
 * report render (configurable delay) so the "enqueue, return immediately,
 * poll for status" shape is visible without a real slow backend.
 */
export function buildReportHandler({ delayMs = 50 } = {}) {
  const rendered = [];
  return {
    handler: async (data) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const result = { report: `report for ${data.topic}`, generatedAt: Date.now() };
      rendered.push({ topic: data.topic, result });
      return result;
    },
    rendered,
  };
}
