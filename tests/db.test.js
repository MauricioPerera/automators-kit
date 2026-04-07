/**
 * Tests: core/db.js
 * DocStore, Collection, indices, query operators, Auth, Table, EncryptedAdapter
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  DocStore, Collection, Auth, Table, EncryptedAdapter, FieldCrypto,
  MemoryStorageAdapter, HashIndex, SortedIndex,
  matchFilter, generateId, createFromTemplate,
} from '../core/db.js';

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
