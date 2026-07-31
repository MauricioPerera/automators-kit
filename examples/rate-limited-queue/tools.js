/**
 * Shared handlers for the rate-limited-queue example: enqueue a report job
 * on core/queue.js's JobQueue, and check its status. Mirrors
 * examples/job-queue/tools.js's getById()-via-DocStore pattern (core/queue.js
 * has no getById() of its own — documented gotcha, not a gap).
 */

/**
 * @param {import('../../core/queue.js').JobQueue} queue
 * @param {import('../../core/db.js').DocStore} db
 */
export function buildRateLimitedQueueTools(queue, db) {
  const jobsCollection = db.collection('_queue_jobs');

  return {
    enqueueReport(params) {
      const job = queue.enqueue('generate-report', params);
      return { jobId: job._id, status: job.status };
    },

    jobStatus(jobId) {
      const job = jobsCollection.findById(jobId);
      if (job) return job;
      return queue.deadLetter(200).find((d) => d._id === jobId) || null;
    },

    stats() { return queue.stats(); },
  };
}
