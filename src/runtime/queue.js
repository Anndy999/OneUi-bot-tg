export const VPS_QUEUE_NAMES = Object.freeze([
  "telegram-update",
  "firmware-query",
  "monitor-check",
  "notification-delivery",
  "maintenance"
]);

function normalizeJobId(value) {
  return value === undefined || value === null ? "" : String(value);
}

function normalizeBullMqJobId(value) {
  return normalizeJobId(value).replaceAll(":", "%3A");
}

export class MemoryQueue {
  constructor(name) {
    if (!VPS_QUEUE_NAMES.includes(String(name))) throw new Error(`Unsupported VPS queue: ${name}`);
    this.name = String(name);
    this.jobs = [];
    this.byId = new Map();
  }

  async add(jobName, data, options = {}) {
    const jobId = normalizeJobId(options.jobId);
    if (jobId && this.byId.has(jobId)) return this.byId.get(jobId);
    const job = {
      id: jobId || `${this.name}:${this.jobs.length + 1}`,
      name: String(jobName),
      data: structuredClone(data),
      opts: { ...options },
      queue: this.name,
      createdAt: new Date().toISOString()
    };
    this.jobs.push(job);
    if (jobId) this.byId.set(jobId, job);
    return job;
  }

  async addBulk(entries) {
    return Promise.all(entries.map((entry) => this.add(entry.name, entry.data, entry.opts)));
  }

  async drain() {
    const jobs = this.jobs.splice(0);
    this.byId.clear();
    return jobs;
  }

  get size() { return this.jobs.length; }
}

export class BullMqQueueAdapter {
  constructor({ Queue, connection, name, prefix = "oneui" } = {}) {
    if (typeof Queue !== "function") throw new TypeError("BullMqQueueAdapter requires BullMQ Queue constructor");
    if (!VPS_QUEUE_NAMES.includes(String(name))) throw new Error(`Unsupported VPS queue: ${name}`);
    this.name = String(name);
    this.queue = new Queue(this.name, { connection, prefix });
  }

  add(jobName, data, options = {}) {
    const jobId = normalizeJobId(options.jobId);
    const bullOptions = jobId ? { ...options, jobId: normalizeBullMqJobId(jobId) } : options;
    return this.queue.add(String(jobName), data, bullOptions);
  }

  addBulk(entries) {
    return this.queue.addBulk(entries);
  }

  close() {
    if (this.queue.connection?.status !== "ready") return this.queue.connection.close(true);
    return this.queue.close();
  }
}

export function createVpsQueues({ Queue, connection, prefix = "oneui", inMemory = false } = {}) {
  const QueueClass = inMemory ? MemoryQueue : BullMqQueueAdapter;
  return Object.fromEntries(VPS_QUEUE_NAMES.map((name) => [
    name,
    inMemory ? new QueueClass(name) : new QueueClass({ Queue, connection, name, prefix })
  ]));
}
