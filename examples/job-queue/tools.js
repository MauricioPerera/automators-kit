/**
 * Shared handlers for the job-queue example: enqueue background jobs on
 * core/queue.js's JobQueue, check status, inspect the dead letter, retry,
 * and purge — the "kick off + poll status" pattern for work too slow to
 * run inline in an HTTP request/response.
 */

/**
 * @param {import('../../core/queue.js').JobQueue} queue
 * @param {import('../../core/db.js').DocStore} db
 */
export function buildQueueTools(queue, db) {
  // core/queue.js has no getById() of its own (only list()/deadLetter(),
  // both filtered-list views) — the DocStore collection it uses internally
  // is a documented public DocStore API (collection(name).findById(id)),
  // just not exposed as a JobQueue method. See README's "gotcha" section.
  const jobsCollection = db.collection('_queue_jobs');

  return {
    enqueueReport(params) {
      const job = queue.enqueue('generate-report', params, { priority: params.priority });
      return { jobId: job._id, status: job.status };
    },

    enqueueNotification(params) {
      const job = queue.enqueue('send-notification', params);
      return { jobId: job._id, status: job.status };
    },

    enqueueFlaky(params) {
      const job = queue.enqueue('flaky-job', params, { maxRetries: params.maxRetries });
      return { jobId: job._id, status: job.status };
    },

    jobStatus(jobId) {
      const job = jobsCollection.findById(jobId);
      if (job) return job;
      // Not in the live collection — completed jobs also stay there until
      // purge(), so "not found" here means either a bad id or the job
      // exhausted retries and moved to the dead letter.
      return queue.deadLetter(200).find((d) => d._id === jobId) || null;
    },

    listJobs(opts) { return queue.list(opts); },
    stats() { return queue.stats(); },
    deadLetterList(limit) { return queue.deadLetter(limit); },
    retryDead(jobId) {
      // queue.retry() returns the raw new job doc ({..., _id}); normalize to
      // the same { jobId, status } shape the enqueue* methods above return,
      // so a caller doesn't need to know retry's return shape differs.
      const job = queue.retry(jobId);
      return job ? { jobId: job._id, status: job.status } : null;
    },
    purgeOld(olderThanMs) { return { purged: queue.purge(olderThanMs) }; },
  };
}
