/**
 * Projects
 * A simple organizational layer above workflow.js: a Project has members
 * with a project-scoped role (separate from core/cms.js's global,
 * instance-wide ROLE_PERMISSIONS), and contains flat Folders that
 * workflows can be filed into -- Project -> Folder -> Workflow, one level,
 * no folder-in-folder nesting.
 *
 * Deliberately simpler than CMS's granular permission-per-action model:
 * 3 ranked roles (owner > editor > viewer), matching what a real
 * organizational layer needs without over-building.
 *
 * Zero dependencies. Mirrors the existing module style (CredentialVault,
 * WorkflowEngine): takes `db` in the constructor, owns its own
 * collections.
 *
 * Usage:
 *   const projects = new ProjectManager(db);
 *   const project = projects.createProject('Marketing', userId);
 *   const folder = projects.createFolder(project._id, 'Campaigns');
 *   projects.hasProjectRole(project._id, userId, 'editor'); // true (owner outranks editor)
 */

export const PROJECT_ROLES = ['owner', 'editor', 'viewer'];
const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 };

export class ProjectManager {
  /** @param {import('./db.js').DocStore} db */
  constructor(db) {
    this.db = db;
    this._projects = db.collection('_projects');
    this._folders = db.collection('_folders');
    try { this._projects.createIndex('name'); } catch {}
    try { this._folders.createIndex('projectId'); } catch {}
  }

  // ── Projects ────────────────────────────────────────────

  /**
   * @param {string} name
   * @param {string} ownerUserId - becomes the project's first `owner` member
   * @param {object} [opts]
   * @param {string} [opts.description]
   */
  createProject(name, ownerUserId, opts = {}) {
    if (!name) throw new Error('createProject: name is required');
    if (!ownerUserId) throw new Error('createProject: ownerUserId is required');
    const project = this._projects.insert({
      name,
      description: opts.description || '',
      members: [{ userId: ownerUserId, role: 'owner' }],
      // Distinct from `members` -- ownership can be transferred/revoked
      // later (removeMember only refuses stripping the LAST owner, not
      // reassigning it), so this is the only durable record of who
      // actually created the project.
      createdBy: ownerUserId,
      updatedBy: ownerUserId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.db.flush();
    return project;
  }

  getProject(id) { return this._projects.findById(id); }

  /** Projects `userId` is a member of; all projects if `userId` is omitted. */
  listProjects(userId) {
    const filter = userId ? { members: { $elemMatch: { userId } } } : {};
    return this._projects.find(filter).sort({ updatedAt: -1 }).toArray();
  }

  updateProject(id, changes, updatedBy = null) {
    const project = this._projects.findById(id);
    if (!project) throw new Error(`Project '${id}' not found`);
    const updates = {};
    for (const k of ['name', 'description']) {
      if (changes[k] !== undefined) updates[k] = changes[k];
    }
    if (updatedBy !== null) updates.updatedBy = updatedBy;
    updates.updatedAt = Date.now();
    this._projects.update({ _id: id }, { $set: updates });
    this.db.flush();
    return this._projects.findById(id);
  }

  /**
   * Removes the project and its folders. Workflows are NOT deleted --
   * their `projectId`/`folderId` are cleared (unassigned), using only the
   * shared DocStore-level API on `_workflows` directly rather than
   * depending on WorkflowEngine's class, keeping the two modules
   * decoupled.
   */
  removeProject(id) {
    this._folders.removeMany({ projectId: id });
    this.db.collection('_workflows').updateMany({ projectId: id }, { $unset: { projectId: 1, folderId: 1 } });
    this._projects.removeById(id);
    this.db.flush();
  }

  // ── Membership ──────────────────────────────────────────

  /** Adds a member, or changes an existing member's role. */
  addMember(projectId, userId, role) {
    if (!PROJECT_ROLES.includes(role)) throw new Error(`Invalid project role: ${role}`);
    const project = this._projects.findById(projectId);
    if (!project) throw new Error(`Project '${projectId}' not found`);
    const members = project.members.filter((m) => m.userId !== userId);
    members.push({ userId, role });
    this._projects.update({ _id: projectId }, { $set: { members, updatedAt: Date.now() } });
    this.db.flush();
  }

  /** Refuses to remove the last remaining `owner` -- a project must always have one. */
  removeMember(projectId, userId) {
    const project = this._projects.findById(projectId);
    if (!project) throw new Error(`Project '${projectId}' not found`);
    const target = project.members.find((m) => m.userId === userId);
    if (!target) return;
    if (target.role === 'owner') {
      const ownerCount = project.members.filter((m) => m.role === 'owner').length;
      if (ownerCount <= 1) throw new Error('Cannot remove the last owner of a project');
    }
    const members = project.members.filter((m) => m.userId !== userId);
    this._projects.update({ _id: projectId }, { $set: { members, updatedAt: Date.now() } });
    this.db.flush();
  }

  getMemberRole(projectId, userId) {
    const project = this._projects.findById(projectId);
    return project?.members.find((m) => m.userId === userId)?.role || null;
  }

  /** True if `userId` holds `minRole` or higher (owner > editor > viewer) in the project. */
  hasProjectRole(projectId, userId, minRole) {
    const role = this.getMemberRole(projectId, userId);
    if (!role) return false;
    return ROLE_RANK[role] >= ROLE_RANK[minRole];
  }

  // ── Folders (flat -- no nesting) ────────────────────────

  createFolder(projectId, name) {
    if (!this._projects.findById(projectId)) throw new Error(`Project '${projectId}' not found`);
    if (!name) throw new Error('createFolder: name is required');
    const folder = this._folders.insert({ projectId, name, createdAt: Date.now(), updatedAt: Date.now() });
    this.db.flush();
    return folder;
  }

  getFolder(id) { return this._folders.findById(id); }

  listFolders(projectId) { return this._folders.find({ projectId }).sort({ name: 1 }).toArray(); }

  /** Removes the folder; workflows filed in it are unassigned, not deleted. */
  removeFolder(id) {
    this.db.collection('_workflows').updateMany({ folderId: id }, { $unset: { folderId: 1 } });
    this._folders.removeById(id);
    this.db.flush();
  }
}
