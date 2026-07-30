/**
 * Task command registry — shared by setup.js (the real stdio MCP server)
 * and the regression test, so the demo and test can't drift apart.
 *
 * A deliberately small domain (tasks: create/list/complete/delete): the
 * point of this example is core/shell-mcp.js's transport shape (exactly 2
 * MCP tools regardless of registry size, discovery via
 * shell_exec("search ...") instead of one schema per command), not another
 * CMS walkthrough.
 */

export const TASK_CONTENT_TYPE = {
  name: 'Task',
  slug: 'task',
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'done', label: 'Done', type: 'boolean' },
  ],
};

function toTask(entry) {
  return { id: entry._id, title: entry.title, done: !!entry.content.done };
}

/**
 * Register the tasks:* commands onto `shell`, backed by `cms`.
 * @param {import('../../core/shell.js').Shell} shell
 * @param {import('../../core/cms.js').CMS} cms
 */
export function registerTaskCommands(shell, cms) {
  shell.registry.register('tasks', 'create', {
    description: 'Create a new task',
    params: [{ name: 'title', type: 'string', required: true }],
  }, async (args) => {
    const entry = await cms.entries.create({
      contentTypeSlug: 'task',
      title: args.title,
      content: { title: args.title, done: false },
      status: 'published',
    });
    return toTask(entry);
  });

  shell.registry.register('tasks', 'list', {
    description: 'List tasks, optionally filtered by completion status',
    params: [{ name: 'done', type: 'boolean' }],
  }, async (args) => {
    const { entries } = cms.entries.findAll({ contentTypeSlug: 'task', limit: 100 });
    const tasks = entries.map(toTask);
    return args.done === undefined ? tasks : tasks.filter((t) => t.done === args.done);
  });

  shell.registry.register('tasks', 'complete', {
    description: 'Mark a task as done',
    params: [{ name: 'id', type: 'string', required: true }],
  }, async (args) => {
    const existing = cms.entries.findById(args.id);
    if (!existing) throw new Error(`Task '${args.id}' not found`);
    // Merge into the existing content — entries.update() replaces `content`
    // wholesale, not per-key, so passing only { done: true } would drop the
    // required `title` field and fail validateContent().
    const updated = await cms.entries.update(args.id, { content: { ...existing.content, done: true } });
    return toTask(updated);
  });

  shell.registry.register('tasks', 'delete', {
    description: 'Delete a task',
    params: [{ name: 'id', type: 'string', required: true }],
  }, async (args) => {
    const deleted = await cms.entries.delete(args.id);
    return { deletedId: deleted._id };
  });

  return shell;
}
