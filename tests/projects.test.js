/**
 * Tests: core/projects.js
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ProjectManager, PROJECT_ROLES } from '../core/projects.js';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';

let db, projects;

beforeEach(() => {
  db = new DocStore(new MemoryStorageAdapter());
  projects = new ProjectManager(db);
});

describe('ProjectManager: projects', () => {
  it('createProject auto-adds the creator as owner', () => {
    const project = projects.createProject('Marketing', 'user-1');
    expect(project.name).toBe('Marketing');
    expect(project.members).toEqual([{ userId: 'user-1', role: 'owner' }]);
    expect(projects.hasProjectRole(project._id, 'user-1', 'owner')).toBe(true);
  });

  it('listProjects(userId) only returns projects that user is a member of', () => {
    const a = projects.createProject('A', 'user-1');
    projects.createProject('B', 'user-2');
    const mine = projects.listProjects('user-1');
    expect(mine.length).toBe(1);
    expect(mine[0]._id).toBe(a._id);
  });

  it('listProjects() with no argument returns everything (admin-style listing)', () => {
    projects.createProject('A', 'user-1');
    projects.createProject('B', 'user-2');
    expect(projects.listProjects().length).toBe(2);
  });

  it('updateProject only touches whitelisted fields', () => {
    const project = projects.createProject('Old Name', 'user-1');
    const updated = projects.updateProject(project._id, { name: 'New Name', description: 'desc', members: [{ userId: 'attacker', role: 'owner' }] });
    expect(updated.name).toBe('New Name');
    expect(updated.description).toBe('desc');
    expect(updated.members).toEqual([{ userId: 'user-1', role: 'owner' }]); // members injection rejected
  });

  it('removeProject removes it and its folders, and unassigns (not deletes) its workflows', () => {
    const project = projects.createProject('Doomed', 'user-1');
    const folder = projects.createFolder(project._id, 'F1');
    db.collection('_workflows').insert({ name: 'WF', projectId: project._id, folderId: folder._id });

    projects.removeProject(project._id);

    expect(projects.getProject(project._id)).toBeNull();
    expect(projects.listFolders(project._id).length).toBe(0);
    const wf = db.collection('_workflows').findOne({ name: 'WF' });
    expect(wf.projectId).toBeUndefined();
    expect(wf.folderId).toBeUndefined();
  });
});

describe('ProjectManager: membership', () => {
  it('addMember adds a new member; re-adding an existing member changes their role', () => {
    const project = projects.createProject('P', 'owner-1');
    projects.addMember(project._id, 'user-2', 'viewer');
    expect(projects.getMemberRole(project._id, 'user-2')).toBe('viewer');

    projects.addMember(project._id, 'user-2', 'editor'); // re-add == role change
    expect(projects.getMemberRole(project._id, 'user-2')).toBe('editor');
    expect(projects.getProject(project._id).members.length).toBe(2); // still 2, not duplicated
  });

  it('addMember rejects an invalid role', () => {
    const project = projects.createProject('P', 'owner-1');
    expect(() => projects.addMember(project._id, 'user-2', 'superadmin')).toThrow();
  });

  it('removeMember removes a non-owner member', () => {
    const project = projects.createProject('P', 'owner-1');
    projects.addMember(project._id, 'user-2', 'viewer');
    projects.removeMember(project._id, 'user-2');
    expect(projects.getMemberRole(project._id, 'user-2')).toBeNull();
  });

  it('removeMember refuses to remove the LAST remaining owner', () => {
    const project = projects.createProject('P', 'owner-1');
    expect(() => projects.removeMember(project._id, 'owner-1')).toThrow('last owner');
    expect(projects.getMemberRole(project._id, 'owner-1')).toBe('owner'); // untouched
  });

  it('removeMember allows removing an owner when another owner remains', () => {
    const project = projects.createProject('P', 'owner-1');
    projects.addMember(project._id, 'owner-2', 'owner');
    projects.removeMember(project._id, 'owner-1'); // fine -- owner-2 still holds the project
    expect(projects.getMemberRole(project._id, 'owner-1')).toBeNull();
    expect(projects.getMemberRole(project._id, 'owner-2')).toBe('owner');
  });

  it('getMemberRole returns null for a non-member', () => {
    const project = projects.createProject('P', 'owner-1');
    expect(projects.getMemberRole(project._id, 'stranger')).toBeNull();
  });

  it('hasProjectRole ranks owner > editor > viewer correctly', () => {
    const project = projects.createProject('P', 'owner-1');
    projects.addMember(project._id, 'ed', 'editor');
    projects.addMember(project._id, 'vw', 'viewer');

    // owner satisfies every threshold
    for (const role of PROJECT_ROLES) expect(projects.hasProjectRole(project._id, 'owner-1', role)).toBe(true);

    // editor satisfies editor/viewer, not owner
    expect(projects.hasProjectRole(project._id, 'ed', 'viewer')).toBe(true);
    expect(projects.hasProjectRole(project._id, 'ed', 'editor')).toBe(true);
    expect(projects.hasProjectRole(project._id, 'ed', 'owner')).toBe(false);

    // viewer satisfies only viewer
    expect(projects.hasProjectRole(project._id, 'vw', 'viewer')).toBe(true);
    expect(projects.hasProjectRole(project._id, 'vw', 'editor')).toBe(false);

    // a non-member satisfies nothing
    expect(projects.hasProjectRole(project._id, 'stranger', 'viewer')).toBe(false);
  });
});

describe('ProjectManager: folders (flat, no nesting)', () => {
  it('createFolder requires an existing project', () => {
    expect(() => projects.createFolder('does-not-exist', 'F1')).toThrow();
  });

  it('listFolders returns only that project\'s folders, sorted by name', () => {
    const a = projects.createProject('A', 'user-1');
    const b = projects.createProject('B', 'user-1');
    projects.createFolder(a._id, 'Zeta');
    projects.createFolder(a._id, 'Alpha');
    projects.createFolder(b._id, 'Other');

    const folders = projects.listFolders(a._id);
    expect(folders.length).toBe(2);
    expect(folders.map((f) => f.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('removeFolder unassigns (not deletes) workflows filed in it', () => {
    const project = projects.createProject('P', 'user-1');
    const folder = projects.createFolder(project._id, 'F1');
    db.collection('_workflows').insert({ name: 'WF1', projectId: project._id, folderId: folder._id });
    db.collection('_workflows').insert({ name: 'WF2', projectId: project._id, folderId: folder._id });

    projects.removeFolder(folder._id);

    expect(projects.getFolder(folder._id)).toBeNull();
    for (const wf of db.collection('_workflows').find({}).toArray()) {
      expect(wf.folderId).toBeUndefined();
      expect(wf.projectId).toBe(project._id); // project assignment survives -- only the folder is cleared
    }
  });
});
