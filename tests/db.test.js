/**
 * Tests: core/db.js
 * DocStore, Collection, indices, query operators, Auth, Table, EncryptedAdapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  DocStore, Collection, Auth, Table, EncryptedAdapter, FieldCrypto,
  MemoryStorageAdapter, FileStorageAdapter, HashIndex, SortedIndex,
  matchFilter, applyUpdate, generateId, createFromTemplate,
} from '../core/db.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function createDb() {
  return new DocStore(new MemoryStorageAdapter());
}

// ---------------------------------------------------------------------------
// DocStore & Collection basics
// ---------------------------------------------------------------------------

describe('DocStore', () => {
  it('creates collections', () => {
    const db = createDb();
    const col = db.collection('users');
    expect(col).toBeDefined();
    expect(db.collection('users')).toBe(col); // same instance
  });

  it('generates unique _id on insert', () => {
    const db = createDb();
    const col = db.collection('items');
    const doc = col.insert({ name: 'A' });
    expect(doc._id).toBeDefined();
    expect(typeof doc._id).toBe('string');
  });

  it('insert + findById', () => {
    const db = createDb();
    const col = db.collection('items');
    const doc = col.insert({ name: 'Alice', age: 30 });
    const found = col.findById(doc._id);
    expect(found.name).toBe('Alice');
    expect(found.age).toBe(30);
  });

  it('insert + findOne', () => {
    const db = createDb();
    const col = db.collection('items');
    col.insert({ name: 'Alice' });
    col.insert({ name: 'Bob' });
    expect(col.findOne({ name: 'Bob' }).name).toBe('Bob');
    expect(col.findOne({ name: 'Nobody' })).toBeNull();
  });

  it('update with $set', () => {
    const db = createDb();
    const col = db.collection('items');
    const doc = col.insert({ name: 'Alice', age: 30 });
    col.update({ _id: doc._id }, { $set: { age: 31 } });
    expect(col.findById(doc._id).age).toBe(31);
  });

  it('update with $inc', () => {
    const db = createDb();
    const col = db.collection('items');
    const doc = col.insert({ name: 'Alice', score: 10 });
    col.update({ _id: doc._id }, { $inc: { score: 5 } });
    expect(col.findById(doc._id).score).toBe(15);
  });

  it('update with $push and $pull', () => {
    const db = createDb();
    const col = db.collection('items');
    const doc = col.insert({ tags: ['a', 'b'] });
    col.update({ _id: doc._id }, { $push: { tags: 'c' } });
    expect(col.findById(doc._id).tags).toEqual(['a', 'b', 'c']);
    col.update({ _id: doc._id }, { $pull: { tags: 'a' } });
    expect(col.findById(doc._id).tags).toEqual(['b', 'c']);
  });

  it('remove + removeById', () => {
    const db = createDb();
    const col = db.collection('items');
    const d1 = col.insert({ name: 'A' });
    const d2 = col.insert({ name: 'B' });
    col.removeById(d1._id);
    expect(col.findById(d1._id)).toBeNull();
    expect(col.findById(d2._id)).not.toBeNull();
  });

  it('count', () => {
    const db = createDb();
    const col = db.collection('items');
    col.insert({ x: 1 });
    col.insert({ x: 2 });
    col.insert({ x: 3 });
    expect(col.count()).toBe(3);
    expect(col.count({ x: { $gte: 2 } })).toBe(2);
  });

  it('flush and reload from adapter', () => {
    const adapter = new MemoryStorageAdapter();
    const db1 = new DocStore(adapter);
    const col1 = db1.collection('items');
    col1.insert({ name: 'persisted' });
    db1.flush();

    const db2 = new DocStore(adapter);
    const col2 = db2.collection('items');
    const docs = col2.find({}).toArray();
    expect(docs.length).toBe(1);
    expect(docs[0].name).toBe('persisted');
  });
});

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

describe('Cursor', () => {
  let col;
  beforeEach(() => {
    const db = createDb();
    col = db.collection('items');
    for (let i = 0; i < 20; i++) {
      col.insert({ name: `item-${i}`, value: i, category: i % 3 === 0 ? 'A' : 'B' });
    }
  });

  it('find().toArray() returns all', () => {
    expect(col.find({}).toArray().length).toBe(20);
  });

  it('sort ascending', () => {
    const docs = col.find({}).sort({ value: 1 }).limit(3).toArray();
    expect(docs[0].value).toBe(0);
    expect(docs[2].value).toBe(2);
  });

  it('sort descending', () => {
    const docs = col.find({}).sort({ value: -1 }).limit(3).toArray();
    expect(docs[0].value).toBe(19);
  });

  it('skip + limit', () => {
    const docs = col.find({}).sort({ value: 1 }).skip(5).limit(3).toArray();
    expect(docs[0].value).toBe(5);
    expect(docs.length).toBe(3);
  });

  it('project', () => {
    const docs = col.find({}).limit(1).project({ name: 1 }).toArray();
    expect(docs[0].name).toBeDefined();
    expect(docs[0].value).toBeUndefined();
  });

  it('first()', () => {
    const doc = col.find({ category: 'A' }).sort({ value: 1 }).first();
    expect(doc.value).toBe(0);
  });

  it('count()', () => {
    expect(col.find({ category: 'A' }).count()).toBe(7); // 0,3,6,9,12,15,18
  });
});

// ---------------------------------------------------------------------------
// Query operators
// ---------------------------------------------------------------------------

describe('Query operators', () => {
  it('$eq, $ne', () => {
    expect(matchFilter({ x: 5 }, { x: { $eq: 5 } })).toBe(true);
    expect(matchFilter({ x: 5 }, { x: { $ne: 5 } })).toBe(false);
    expect(matchFilter({ x: 5 }, { x: { $ne: 3 } })).toBe(true);
  });

  it('$gt, $gte, $lt, $lte', () => {
    expect(matchFilter({ x: 10 }, { x: { $gt: 5 } })).toBe(true);
    expect(matchFilter({ x: 10 }, { x: { $gte: 10 } })).toBe(true);
    expect(matchFilter({ x: 10 }, { x: { $lt: 15 } })).toBe(true);
    expect(matchFilter({ x: 10 }, { x: { $lte: 10 } })).toBe(true);
    expect(matchFilter({ x: 10 }, { x: { $gt: 10 } })).toBe(false);
  });

  it('$in, $nin', () => {
    expect(matchFilter({ x: 'a' }, { x: { $in: ['a', 'b'] } })).toBe(true);
    expect(matchFilter({ x: 'c' }, { x: { $in: ['a', 'b'] } })).toBe(false);
    expect(matchFilter({ x: 'a' }, { x: { $nin: ['a', 'b'] } })).toBe(false);
  });

  it('$between', () => {
    expect(matchFilter({ x: 5 }, { x: { $between: [1, 10] } })).toBe(true);
    expect(matchFilter({ x: 0 }, { x: { $between: [1, 10] } })).toBe(false);
    expect(matchFilter({ x: 10 }, { x: { $between: [1, 10] } })).toBe(true); // inclusive
  });

  it('$exists', () => {
    expect(matchFilter({ x: 1 }, { x: { $exists: true } })).toBe(true);
    expect(matchFilter({}, { x: { $exists: true } })).toBe(false);
    expect(matchFilter({}, { x: { $exists: false } })).toBe(true);
  });

  it('$regex', () => {
    expect(matchFilter({ name: 'Alice' }, { name: { $regex: '^Ali' } })).toBe(true);
    expect(matchFilter({ name: 'Bob' }, { name: { $regex: '^Ali' } })).toBe(false);
    expect(matchFilter({ name: 'abc123' }, { name: { $regex: '[0-9]+' } })).toBe(true);
    expect(matchFilter({ name: 'no digits' }, { name: { $regex: '[0-9]+' } })).toBe(false);
  });

  it('$regex rejects catastrophic (ReDoS) patterns before .test()', () => {
    // String diseñado para disparar backtracking catastrofico si el patrón
    // llegara a ejecutarse. Timeout bajo: si el fix no funciona, el test
    // falla por timeout en vez de colgar la suite entera.
    const evil = 'a'.repeat(30) + '!';
    expect(() => matchFilter({ name: evil }, { name: { $regex: '(a+)+$' } })).toThrow();
    expect(() => matchFilter({ name: evil }, { name: { $regex: '(a*)*$' } })).toThrow();
    expect(() => matchFilter({ name: evil }, { name: { $regex: '(a+)*$' } })).toThrow();
    expect(() => matchFilter({ name: evil }, { name: { $regex: '((a+)+)+' } })).toThrow();
    // Mismo chequeo cuando el regex llega como instancia RegExp en el filtro.
    expect(() => matchFilter({ name: evil }, { name: new RegExp('(a+)+$') })).toThrow();
  }, 2000);

  it('$regex rejects patterns exceeding the length limit', () => {
    const tooLong = 'a'.repeat(201);
    expect(() => matchFilter({ name: 'abc' }, { name: { $regex: tooLong } })).toThrow();
    // Un patrón exactamente en el limite (200) NO se rechaza por longitud.
    const atLimit = 'a'.repeat(200);
    expect(() => matchFilter({ name: 'abc' }, { name: { $regex: atLimit } })).not.toThrow();
  });

  it('$contains on array', () => {
    expect(matchFilter({ tags: ['a', 'b'] }, { tags: { $contains: 'a' } })).toBe(true);
    expect(matchFilter({ tags: ['a', 'b'] }, { tags: { $contains: 'c' } })).toBe(false);
  });

  it('$contains on string', () => {
    expect(matchFilter({ name: 'hello world' }, { name: { $contains: 'world' } })).toBe(true);
    expect(matchFilter({ name: 'hello' }, { name: { $contains: 'world' } })).toBe(false);
  });

  it('$containsAny', () => {
    expect(matchFilter({ tags: ['a', 'b', 'c'] }, { tags: { $containsAny: ['b', 'x'] } })).toBe(true);
    expect(matchFilter({ tags: ['a', 'b'] }, { tags: { $containsAny: ['x', 'y'] } })).toBe(false);
  });

  it('$containsNone', () => {
    expect(matchFilter({ tags: ['a', 'b'] }, { tags: { $containsNone: ['x', 'y'] } })).toBe(true);
    expect(matchFilter({ tags: ['a', 'b'] }, { tags: { $containsNone: ['a', 'x'] } })).toBe(false);
  });

  it('$size', () => {
    expect(matchFilter({ tags: ['a', 'b'] }, { tags: { $size: 2 } })).toBe(true);
    expect(matchFilter({ tags: ['a'] }, { tags: { $size: 2 } })).toBe(false);
  });

  it('$len', () => {
    expect(matchFilter({ code: 'ABC123' }, { code: { $len: 6 } })).toBe(true);
    expect(matchFilter({ code: 'AB' }, { code: { $len: 6 } })).toBe(false);
  });

  it('$type', () => {
    expect(matchFilter({ x: [1, 2] }, { x: { $type: 'array' } })).toBe(true);
    expect(matchFilter({ x: 'hello' }, { x: { $type: 'string' } })).toBe(true);
    expect(matchFilter({ x: null }, { x: { $type: 'null' } })).toBe(true);
    expect(matchFilter({ x: 42 }, { x: { $type: 'number' } })).toBe(true);
    expect(matchFilter({ x: 42 }, { x: { $type: 'string' } })).toBe(false);
  });

  it('$finite', () => {
    expect(matchFilter({ x: 42 }, { x: { $finite: true } })).toBe(true);
    expect(matchFilter({ x: Infinity }, { x: { $finite: true } })).toBe(false);
    expect(matchFilter({ x: NaN }, { x: { $finite: true } })).toBe(false);
  });

  it('$elemMatch', () => {
    const doc = { items: [{ price: 50 }, { price: 150 }, { price: 30 }] };
    expect(matchFilter(doc, { items: { $elemMatch: { price: { $gt: 100 } } } })).toBe(true);
    expect(matchFilter(doc, { items: { $elemMatch: { price: { $gt: 200 } } } })).toBe(false);
  });

  it('$and, $or, $not', () => {
    const doc = { age: 25, active: true };
    expect(matchFilter(doc, { $and: [{ age: { $gte: 18 } }, { active: true }] })).toBe(true);
    expect(matchFilter(doc, { $or: [{ age: { $lt: 18 } }, { active: true }] })).toBe(true);
    expect(matchFilter(doc, { $not: { active: false } })).toBe(true);
  });

  it('dot notation', () => {
    const doc = { address: { city: 'Madrid', zip: '28001' } };
    expect(matchFilter(doc, { 'address.city': 'Madrid' })).toBe(true);
    expect(matchFilter(doc, { 'address.city': 'Barcelona' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Indices
// ---------------------------------------------------------------------------

describe('Indices', () => {
  it('HashIndex unique constraint', () => {
    const db = createDb();
    const col = db.collection('users');
    col.createIndex('email', { unique: true });
    col.insert({ email: 'a@test.com' });
    expect(() => col.insert({ email: 'a@test.com' })).toThrow();
  });

  it('HashIndex accelerates findOne', () => {
    const db = createDb();
    const col = db.collection('users');
    col.createIndex('email', { unique: true });
    col.insert({ email: 'alice@test.com', name: 'Alice' });
    col.insert({ email: 'bob@test.com', name: 'Bob' });
    const found = col.findOne({ email: 'bob@test.com' });
    expect(found.name).toBe('Bob');
  });

  it('SortedIndex for range queries', () => {
    const db = createDb();
    const col = db.collection('items');
    col.createIndex('value', { type: 'sorted' });
    for (let i = 0; i < 100; i++) col.insert({ value: i });
    const results = col.find({ value: { $gte: 90 } }).toArray();
    expect(results.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe('Aggregation', () => {
  let db, orders, users;
  beforeEach(() => {
    db = createDb();
    users = db.collection('users');
    orders = db.collection('orders');
    users.insert({ _id: 'u1', name: 'Alice' });
    users.insert({ _id: 'u2', name: 'Bob' });
    orders.insert({ userId: 'u1', product: 'GPU', price: 500 });
    orders.insert({ userId: 'u1', product: 'RAM', price: 100 });
    orders.insert({ userId: 'u2', product: 'SSD', price: 200 });
  });

  it('match + group + sort', () => {
    const result = orders.aggregate()
      .group('userId', {
        total: { $sum: 'price' },
        count: { $count: true },
      })
      .sort({ total: -1 })
      .toArray();

    expect(result[0]._id).toBe('u1');
    expect(result[0].total).toBe(600);
    expect(result[0].count).toBe(2);
    expect(result[1].total).toBe(200);
  });

  it('lookup (join)', () => {
    const result = orders.aggregate()
      .lookup({ from: 'users', localField: 'userId', foreignField: '_id', as: 'user', single: true })
      .toArray();

    expect(result[0].user.name).toBe('Alice');
    expect(result[2].user.name).toBe('Bob');
  });

  it('$min/$max with valid data', () => {
    const result = orders.aggregate()
      .group('userId', {
        minPrice: { $min: 'price' },
        maxPrice: { $max: 'price' },
      })
      .toArray();

    const alice = result.find(r => r._id === 'u1');
    expect(alice.minPrice).toBe(100);
    expect(alice.maxPrice).toBe(500);
  });

  it('$min/$max returns null for empty/invalid data', () => {
    const col = db.collection('empty');
    col.insert({ group: 'a', val: 'not-a-number' });
    const result = col.aggregate()
      .group('group', { minVal: { $min: 'val' } })
      .toArray();
    expect(result[0].minVal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth', () => {
  let db, auth;
  beforeEach(async () => {
    db = createDb();
    auth = new Auth(db, { secret: 'test-secret-key-32chars!!!!!!!!!' });
    await auth.init();
  });

  it('register + login', async () => {
    const user = await auth.register('alice@test.com', 'password123', { name: 'Alice' });
    expect(user.email).toBe('alice@test.com');

    const result = await auth.login('alice@test.com', 'password123');
    expect(result.token).toBeDefined();
    expect(result.user.email).toBe('alice@test.com');
  });

  it('login fails with wrong password', async () => {
    await auth.register('bob@test.com', 'correct-pass');
    try {
      await auth.login('bob@test.com', 'wrong-pass');
      expect(true).toBe(false); // should throw
    } catch (err) {
      expect(err.message).toContain('Invalid credentials');
    }
  });

  it('verify token', async () => {
    await auth.register('carol@test.com', 'pass123456');
    const { token } = await auth.login('carol@test.com', 'pass123456');
    const payload = await auth.verify(token);
    expect(payload).not.toBeNull();
    expect(payload.email).toBe('carol@test.com');
  });

  it('duplicate email throws', async () => {
    await auth.register('dup@test.com', 'pass1234567');
    try {
      await auth.register('dup@test.com', 'pass1234567');
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err.message).toContain('Unique constraint');
    }
  });

  it('logout invalidates token', async () => {
    await auth.register('logout@test.com', 'pass1234567');
    const { token } = await auth.login('logout@test.com', 'pass1234567');
    auth.logout(token);
    const payload = await auth.verify(token);
    expect(payload).toBeNull();
  });

  it('roles: assign and check', async () => {
    const user = await auth.register('role@test.com', 'pass1234567', { roles: ['user'] });
    auth.assignRole(user._id, 'admin');
    expect(auth.hasRole(user._id, 'admin')).toBe(true);
    auth.removeRole(user._id, 'admin');
    expect(auth.hasRole(user._id, 'admin')).toBe(false);
  });

  it('a second Auth.init() against already-persisted data does not throw, and logs only the message (not the whole Error) when an index already exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-restart-'));
    try {
      const db1 = new DocStore(new FileStorageAdapter(dir));
      const auth1 = new Auth(db1, { secret: 'test-secret-key-32chars!!!!!!!!!' });
      await auth1.init();
      await auth1.register('restart@test.com', 'pass1234567');
      db1.flush();

      const errors = [];
      const originalError = console.error;
      console.error = (...args) => errors.push(args);
      try {
        const db2 = new DocStore(new FileStorageAdapter(dir));
        const auth2 = new Auth(db2, { secret: 'test-secret-key-32chars!!!!!!!!!' });
        await expect(auth2.init()).resolves.toBeUndefined();
      } finally {
        console.error = originalError;
      }

      // _ensureLoaded() already restored the persisted indexes, so all 3
      // createIndex() calls throw "already exists" and get caught -- each
      // logged call's error argument must be the message string, not the
      // raw Error object (which Bun renders with a full stack trace).
      expect(errors.length).toBe(3);
      for (const [, errArg] of errors) {
        expect(typeof errArg).toBe('string');
        expect(errArg).toContain('Index already exists');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Table (schema validation)
// ---------------------------------------------------------------------------

describe('Table', () => {
  it('validates required fields', () => {
    const db = createDb();
    const t = new Table(db, 'contacts', {
      columns: [
        { name: 'Name', type: 'text', required: true },
        { name: 'Email', type: 'email' },
      ],
    });
    expect(() => t.insert({ Email: 'x@test.com' })).toThrow(); // Name missing
  });

  it('validates email format', () => {
    const db = createDb();
    const t = new Table(db, 'contacts', {
      columns: [
        { name: 'Name', type: 'text', required: true },
        { name: 'Email', type: 'email' },
      ],
    });
    expect(() => t.insert({ Name: 'Test', Email: 'not-an-email' })).toThrow();
  });

  it('insert with defaults and autonumber', () => {
    const db = createDb();
    const t = new Table(db, 'tasks', {
      columns: [
        { name: 'Title', type: 'text', required: true },
        { name: 'Status', type: 'select', options: ['todo', 'done'], default: 'todo' },
        { name: 'Number', type: 'autonumber' },
      ],
    });
    const d1 = t.insert({ Title: 'Task 1' });
    const d2 = t.insert({ Title: 'Task 2' });
    expect(d1.Status).toBe('todo');
    expect(d1.Number).toBe(1);
    expect(d2.Number).toBe(2);
  });

  it('Infinity rejected by number validation', () => {
    const db = createDb();
    const t = new Table(db, 'nums', {
      columns: [{ name: 'Value', type: 'number' }],
    });
    expect(() => t.insert({ Value: Infinity })).toThrow();
    expect(() => t.insert({ Value: -Infinity })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// generateId
// ---------------------------------------------------------------------------

describe('generateId', () => {
  it('generates unique strings', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) ids.add(generateId());
    expect(ids.size).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Prototype pollution protection (FIX-03)
// ---------------------------------------------------------------------------

describe('Prototype pollution protection', () => {
  // Limpia Object.prototype antes y después de cada test para aislar el
  // estado global: si una protección falla y contamina, no debe filtrarse
  // a otros tests ni dar un falso verde por herencia.
  beforeEach(() => { delete ({}).__proto__.polluted; });
  afterEach(()  => { delete ({}).__proto__.polluted; });

  it('$set con __proto__ no contamina Object.prototype y lanza', () => {
    const doc = { name: 'Alice' };
    expect(() => applyUpdate(doc, { $set: { '__proto__.polluted': true } })).toThrow();
    expect(({}).polluted).toBeUndefined();
  });

  it('$set con constructor.prototype no contamina Object.prototype y lanza', () => {
    const doc = { name: 'Alice' };
    expect(() => applyUpdate(doc, { $set: { 'constructor.prototype.polluted': true } })).toThrow();
    expect(({}).polluted).toBeUndefined();
  });

  it('$unset con __proto__ lanza y no contamina', () => {
    const doc = { name: 'Alice' };
    expect(() => applyUpdate(doc, { $unset: { '__proto__.polluted': true } })).toThrow();
    expect(({}).polluted).toBeUndefined();
  });

  it('$inc con __proto__ lanza y no contamina', () => {
    const doc = { name: 'Alice' };
    expect(() => applyUpdate(doc, { $inc: { '__proto__.polluted': 1 } })).toThrow();
    expect(({}).polluted).toBeUndefined();
  });

  it('$push con constructor.prototype lanza y no contamina', () => {
    const doc = { tags: ['a'] };
    expect(() => applyUpdate(doc, { $push: { 'constructor.prototype.polluted': 'x' } })).toThrow();
    expect(({}).polluted).toBeUndefined();
  });

  it('segmento peligroso en posición intermedia lanza', () => {
    const doc = { a: {} };
    expect(() => applyUpdate(doc, { $set: { 'a.__proto__.polluted': true } })).toThrow();
    expect(({}).polluted).toBeUndefined();
  });

  it('los updates legítimos (paths normales) siguen funcionando igual', () => {
    // $set anidado
    const d1 = applyUpdate({ a: { b: { c: 1 } } }, { $set: { 'a.b.c': 2, 'a.b.d': 3 } });
    expect(d1.a.b.c).toBe(2);
    expect(d1.a.b.d).toBe(3);

    // $inc anidado
    const d2 = applyUpdate({ score: { n: 10 } }, { $inc: { 'score.n': 5 } });
    expect(d2.score.n).toBe(15);

    // $push anidado
    const d3 = applyUpdate({ tags: { items: ['a'] } }, { $push: { 'tags.items': 'b' } });
    expect(d3.tags.items).toEqual(['a', 'b']);

    // $unset anidado
    const d4 = applyUpdate({ a: { b: 1, c: 2 } }, { $unset: { 'a.b': 1 } });
    expect(d4.a.b).toBeUndefined();
    expect(d4.a.c).toBe(2);

    // Sin contaminación colateral
    expect(({}).polluted).toBeUndefined();
  });

  it('a nivel de Collection.update, el path peligroso no contamina', () => {
    const db = createDb();
    const col = db.collection('items');
    const doc = col.insert({ name: 'Alice' });
    expect(() => col.update({ _id: doc._id }, { $set: { '__proto__.polluted': true } })).toThrow();
    expect(({}).polluted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FIX-20: durability & security hardening (5 hallazgos MEDIUM)
// ---------------------------------------------------------------------------

describe('FIX-20: atomic writes (Hallazgo 1)', () => {
  it('FileStorageAdapter.writeJson escribe a .tmp y renombra (atomico)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix20-atomic-'));
    try {
      const adapter = new FileStorageAdapter(dir);
      const realFs = adapter.fs;
      const calls = { writeFileSync: [], renameSync: [] };
      // Spy sobre fs: registra llamadas sin alterar el comportamiento real.
      adapter.fs = new Proxy(realFs, {
        get(t, prop) {
          if (prop === 'writeFileSync') {
            return (...args) => { calls.writeFileSync.push(args[0]); return t.writeFileSync(...args); };
          }
          if (prop === 'renameSync') {
            return (...args) => { calls.renameSync.push({ from: args[0], to: args[1] }); return t.renameSync(...args); };
          }
          return Reflect.get(t, prop);
        },
      });

      adapter.writeJson('col.json', { a: 1, nested: { b: 2 } });

      // 1) escribió a un archivo .tmp (nunca al final directo)
      expect(calls.writeFileSync.length).toBe(1);
      expect(String(calls.writeFileSync[0]).endsWith('col.json.tmp')).toBe(true);
      // 2) renombró tmp -> final atómicamente
      expect(calls.renameSync.length).toBe(1);
      expect(String(calls.renameSync[0].from).endsWith('col.json.tmp')).toBe(true);
      expect(String(calls.renameSync[0].to).endsWith('col.json')).toBe(true);
      // 3) el archivo final es válido y no queda .tmp residual
      expect(realFs.existsSync(join(dir, 'col.json'))).toBe(true);
      expect(realFs.existsSync(join(dir, 'col.json.tmp'))).toBe(false);
      expect(adapter.readJson('col.json')).toEqual({ a: 1, nested: { b: 2 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('FIX-20: stale persistent index forces rebuild (Hallazgo 2)', () => {
  it('un indice persistido inconsistente con los docs fuerza rebuild (no resultados incompletos)', () => {
    const adapter = new MemoryStorageAdapter();
    const db1 = new DocStore(adapter);
    const col1 = db1.collection('items');
    col1.createIndex('value', { type: 'sorted' });
    for (let i = 0; i < 50; i++) col1.insert({ _id: 'i' + i, value: i });
    col1.flush();

    const idxFile = 'items.value.sidx.json';
    const state = adapter.readJson(idxFile);
    expect(state.entries.length).toBe(50);

    // Simular flush parcial: docs persistidos, indice stale (1 sola entrada).
    adapter.writeJson(idxFile, { field: 'value', entries: [state.entries[0]] });

    // Nuevo store carga desde el adapter; el indice stale NO debe usarse.
    const db2 = new DocStore(adapter);
    const col2 = db2.collection('items');
    const results = col2.find({ value: { $gte: 45 } }).toArray();
    // Si se hubiera usado el indice stale (1 entrada), devolveria 0 docs.
    // Con rebuild devuelve los 5 correctos (45..49).
    expect(results.length).toBe(5);
    expect(results.map(r => r.value)).toEqual([45, 46, 47, 48, 49]);
  });

  it('un indice persistido consistente con los docs se reutiliza (round-trip)', () => {
    const adapter = new MemoryStorageAdapter();
    const db1 = new DocStore(adapter);
    const col1 = db1.collection('items');
    col1.createIndex('value', { type: 'sorted' });
    for (let i = 0; i < 50; i++) col1.insert({ _id: 'i' + i, value: i });
    col1.flush();

    const db2 = new DocStore(adapter);
    const col2 = db2.collection('items');
    // El indice persistido es consistente -> se carga y responde correctamente.
    expect(col2.find({ value: { $gte: 45 } }).toArray().length).toBe(5);
    expect(col2.find({ value: { $lt: 5 } }).toArray().length).toBe(5);
  });
});

describe('FIX-20: EncryptedAdapter.readJson fail-loud (Hallazgo 3)', () => {
  it('lanza si hay datos encriptados sin preload (antes devolvia null silencioso)', async () => {
    const inner = new MemoryStorageAdapter();
    const enc = await EncryptedAdapter.create(inner, 'pw', 'explicit-salt');
    enc.writeJson('secret.json', { secret: 'shh' });
    await enc.persist();

    // Nueva instancia, mismo inner+password+salt, SIN preload.
    const enc2 = await EncryptedAdapter.create(inner, 'pw', 'explicit-salt');
    expect(() => enc2.readJson('secret.json')).toThrow(/preload/);
  });

  it('devuelve datos desencriptados tras preload (no rompi el path correcto)', async () => {
    const inner = new MemoryStorageAdapter();
    const enc = await EncryptedAdapter.create(inner, 'pw', 'explicit-salt');
    enc.writeJson('secret.json', { secret: 'shh' });
    await enc.persist();

    const enc2 = await EncryptedAdapter.create(inner, 'pw', 'explicit-salt');
    await enc2.preload(['secret.json']);
    expect(enc2.readJson('secret.json')).toEqual({ secret: 'shh' });
  });
});

describe('FIX-20: PBKDF2 salt (Hallazgo 4)', () => {
  it('sin salt explicito: genera uno aleatorio y lo persiste (sobrevive restart, misma key)', async () => {
    const inner = new MemoryStorageAdapter();
    const a = await EncryptedAdapter.create(inner, 'master-pw'); // sin salt -> random persistido
    // el salt se persistio en el adapter interno
    const persisted = inner.readJson('__enc.salt.json');
    expect(persisted).toBeDefined();
    expect(typeof persisted.salt).toBe('string');
    expect(persisted.salt.length).toBeGreaterThan(0);

    a.writeJson('data.json', { msg: 'hello' });
    await a.persist();

    // Nueva instancia, mismo inner+password, sin salt -> lee el salt persistido -> misma key
    const b = await EncryptedAdapter.create(inner, 'master-pw');
    await b.preload(['data.json']);
    expect(b.readJson('data.json')).toEqual({ msg: 'hello' });
  });

  it('salt aleatorio distinto por almacenamiento -> keys distintas (no rainbow global)', async () => {
    const innerA = new MemoryStorageAdapter();
    const innerB = new MemoryStorageAdapter();
    const a = await EncryptedAdapter.create(innerA, 'master-pw');
    a.writeJson('data.json', { msg: 'hello' });
    await a.persist();

    // Copiar el blob encriptado de A al almacenamiento de B.
    innerB.writeJson('data.json', innerA.readJson('data.json'));

    // B deriva su propio salt aleatorio -> key distinta -> no puede desencriptar.
    const b = await EncryptedAdapter.create(innerB, 'master-pw');
    await b.preload(['data.json']);
    expect(b.readJson('data.json')).toBeNull(); // desencripto con key equivocada
  });
});

describe('FIX-20: Collection.import error visibility (Hallazgo 5)', () => {
  it('salta duplicados legitimos (Duplicate _id / Unique constraint)', () => {
    const db = createDb();
    const col = db.collection('users');
    col.createIndex('email', { unique: true });
    col.insert({ _id: 'u1', email: 'a@test.com' });
    const count = col.import([
      { _id: 'u1', email: 'x@test.com' }, // dup _id -> skip
      { _id: 'u2', email: 'a@test.com' }, // dup unique email -> skip
      { _id: 'u3', email: 'b@test.com' }, // ok
    ]);
    expect(count).toBe(1);
    expect(col.findById('u3')).toBeDefined();
  });

  it('re-lanza errores NO relacionados a duplicados (no los traga)', () => {
    const db = createDb();
    const col = db.collection('users');
    col.createIndex('email', { unique: true });
    col.insert({ _id: 'u1', email: 'a@test.com' });

    // El doc con una funcion no es clonable (structuredClone lanza) -> error
    // no relacionado a duplicados -> debe re-lanzarse, no saltarse.
    expect(() => col.import([
      { _id: 'u1', email: 'x@test.com' },                    // dup _id -> skip
      { _id: 'u2', email: 'a@test.com' },                    // dup email -> skip
      { _id: 'u3', email: 'b@test.com', fn: () => {} },      // error de clone -> re-lanzar
    ])).toThrow();
    // el doc que fallo no quedo insertado
    expect(col.findById('u3')).toBeNull();
  });
});

describe('FieldCrypto salt (FIX-41)', () => {
  it('create(password) sin salt explícito lanza (no usa default hardcodeado)', async () => {
    await expect(FieldCrypto.create('some-password')).rejects.toThrow(/explicit salt/);
    await expect(FieldCrypto.create('some-password', '')).rejects.toThrow(/explicit salt/);
    await expect(FieldCrypto.create('some-password', null)).rejects.toThrow(/explicit salt/);
  });

  it('create(password, salt) con salt explícito sigue funcionando (encrypt/decrypt)', async () => {
    const crypto = await FieldCrypto.create('master-password', 'a-unique-random-salt');
    const enc = await crypto.encrypt('secret-value');
    expect(enc.startsWith('$enc$')).toBe(true);
    const dec = await crypto.decrypt(enc);
    expect(dec).toBe('secret-value');
  });
});
