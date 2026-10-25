/**
 * Minimal in-memory Firestore double for auth unit tests.
 *
 * Only the surface used by the auth routes is implemented. The important
 * semantic is `create()`: existence is checked synchronously at call time, so
 * concurrent claims behave like a single-document transactional write — exactly
 * one succeeds and the rest fail with gRPC code 6 (ALREADY_EXISTS).
 */

function alreadyExistsError(id) {
  const error = new Error(`ALREADY_EXISTS: document usernames/${id} already exists`);
  error.code = 6;
  return error;
}

function snapshot(id, data) {
  return {
    id,
    exists: data !== undefined,
    data: () => (data === undefined ? undefined : structuredClone(data))
  };
}

/**
 * A value a range comparison can use. A Date and a Firestore-shaped timestamp both fold to
 * milliseconds; anything else compares as itself, and `null` means "this row has no such
 * value", which no range operator matches - exactly as in Firestore.
 */
function asComparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === 'object' && typeof value.toDate === 'function') {
    const ms = value.toDate().getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (value && typeof value === 'object' && typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  if (value === undefined) return null;
  return value;
}

function createFakeFirestore(seed = {}, { serializable = false } = {}) {
  const stores = new Map();
  let autoIdCounter = 1;
  for (const [name, docs] of Object.entries(seed)) {
    stores.set(name, new Map(Object.entries(docs).map(([id, data]) => [id, structuredClone(data)])));
  }

  // Injected infrastructure faults, so a test can make one document read or write
  // fail exactly the way a dropped Firestore connection would.
  const faults = new Set();
  function checkFault(name, id, operation) {
    const key = `${name}/${id}#${operation}`;
    if (!faults.has(key)) return;
    const error = new Error(`injected failure: ${operation} on ${key}`);
    error.code = 14; // gRPC UNAVAILABLE
    throw error;
  }

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  // The write primitives are synchronous on purpose. A transaction's queued writes are
  // applied by the same helpers below, so the whole commit happens in one synchronous
  // step: nothing else can slip between the conflict check and the last document landing,
  // which is how a real commit is atomic. `set` and `create` keep the same fault keys and
  // the same uniqueness rule as before, so the suites that were written against this
  // double still see the behaviour they were written for.
  function applySet(name, id, data, options = {}) {
    checkFault(name, id, 'set');
    const docs = store(name);
    docs.set(id, options.merge
      ? { ...(docs.get(id) || {}), ...structuredClone(data) }
      : structuredClone(data));
    return { writeTime: 'fake' };
  }

  function applyCreate(name, id, data) {
    checkFault(name, id, 'create');
    const docs = store(name);
    if (docs.has(id)) throw alreadyExistsError(id);
    docs.set(id, structuredClone(data));
    return { writeTime: 'fake' };
  }

  function applyDelete(name, id) {
    checkFault(name, id, 'delete');
    store(name).delete(id);
    return { writeTime: 'fake' };
  }

  function reference(name, id) {
    return {
      id,
      path: `${name}/${id}`,
      __store: name,
      // Subcollections are keyed by their full path, matching how a document
      // reference exposes `.collection()` in the real SDK.
      collection: sub => collection(`${name}/${id}/${sub}`),
      async get() {
        checkFault(name, id, 'get');
        return snapshot(id, store(name).get(id));
      },
      async create(data) {
        return applyCreate(name, id, data);
      },
      async set(data, options = {}) {
        return applySet(name, id, data, options);
      },
      async delete() {
        return applyDelete(name, id);
      }
    };
  }

  // A query accumulates filters rather than replacing them, which is what a service that adds
  // an equality and then a range has to see. `==` keeps its old strict comparison; the range
  // operators compare numbers, and a Firestore Timestamp or a Date both fold to their
  // milliseconds, so a deadline query is checked against the same values the real backend
  // indexes. A collection is itself a query with no filters, so `collection().limit(n)` works
  // the way the SDK allows it to.
  function queryFor(name) {
    const filters = [];
    let limit = Infinity;
    // One ordering, applied before the limit, which is the only shape a Firestore read of a
    // history has: newest first and bounded. The comparison folds timestamps and dates to
    // milliseconds through the same helper the range filters use, so an `orderBy createdAt desc`
    // over rows written with a server timestamp is actually checkable here.
    let ordering = null;
    // A paging cursor, as `startAfter(value)` or `startAfter(value, documentId)`. The real SDK
    // resolves it against the ordering in force, which for a single-field `orderBy` is that field
    // and then the document name; the comparator below is the same one the sort uses, so a page
    // that is walked in tests skips and repeats exactly as it would in production.
    let after = null;
    const passes = data => filters.every(({ field, operator, value }) => {
      const seen = data[field];
      const left = asComparable(seen);
      const right = asComparable(value);
      switch (operator) {
        case '==': return seen === value;
        case '!=': return seen !== value;
        case '>': return left !== null && right !== null && left > right;
        case '>=': return left !== null && right !== null && left >= right;
        case '<': return left !== null && right !== null && left < right;
        case '<=': return left !== null && right !== null && left <= right;
        case 'in': return Array.isArray(value) && value.includes(seen);
        case 'array-contains': return Array.isArray(seen) && seen.includes(value);
        default: throw new Error(`Unsupported operator in fake: ${operator}`);
      }
    });
    /** The order two rows come back in, including the implicit document-name tiebreak. */
    function compareRows(leftRow, rightRow) {
      const key = ordering.field;
      const sign = ordering.direction === 'desc' ? -1 : 1;
      const a = asComparable(((leftRow[1] || {})[key]));
      const b = asComparable(((rightRow[1] || {})[key]));
      // A row with no such field sorts last in either direction, which keeps a bounded page of
      // "newest first" from being led by a document that never recorded a time.
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      if (a !== b) return (a < b ? -1 : 1) * sign;
      // Equal values: the document name decides, in the same direction as the last orderBy.
      if (leftRow[0] === rightRow[0]) return 0;
      return (leftRow[0] < rightRow[0] ? -1 : 1) * sign;
    }
    const query = {
      // The marker a transaction uses to tell a query from a document reference. The real Admin
      // SDK accepts either in `transaction.get()`, and a service that counts a day inside its
      // creation transaction depends on that.
      __query: true,
      where(...args) {
        filters.push({ field: args[0], operator: args[1], value: args[2] });
        return query;
      },
      orderBy(field, direction = 'asc') {
        ordering = { field, direction: String(direction).toLowerCase() === 'desc' ? 'desc' : 'asc' };
        return query;
      },
      startAfter(...values) {
        after = { value: values[0], id: values[1] };
        return query;
      },
      limit(n) {
        limit = n;
        return query;
      },
      async get() {
        return query.__snapshot();
      },
      // The same read, exposed so a transaction can take it without going through `get()`.
      __snapshot() {
        let matches = [...store(name).entries()]
          .filter(([, data]) => passes(data || {}));
        if (ordering) {
          matches.sort(compareRows);
          if (after) {
            // The cursor row carries only the ordering field and its name, which is all the
            // comparator looks at.
            const cursorRow = [
              after.id === undefined ? '' : after.id,
              { [ordering.field]: after.value }
            ];
            matches = matches.filter(row => compareRows(row, cursorRow) > 0);
          }
        }
        return { empty: matches.length === 0, size: Math.min(matches.length, limit),
          docs: matches.slice(0, limit).map(([id, data]) => snapshot(id, data)) };
      }
    };
    return query;
  }

  function collection(name) {
    return {
      id: name,
      // A document reference with no id asked for is what the real SDK calls an auto-id, which is
      // how the project's existing transcript rows are written (`transcripts/{section}/entries`).
      // Uniqueness is all an audit row needs, so a counter is enough and no id is ever reused.
      // `doc()` and `document()` are the same call in the real SDK, and the audit trail is written
      // with the long name because that is what the project's existing transcript logging uses. A
      // double that only had one of the two made every audit row fail to write, quietly, in tests
      // that never looked - so both names are here.
      doc: id => reference(name, id === undefined ? `auto_${name}_${autoIdCounter++}` : id),
      document: id => reference(name, id === undefined ? `auto_${name}_${autoIdCounter++}` : id),
      // Each call starts a fresh query, so two listings built from one collection never
      // inherit each other's filters.
      where: (...args) => queryFor(name).where(...args),
      limit: n => queryFor(name).limit(n),
      orderBy: (...args) => queryFor(name).orderBy(...args),
      async get() {
        const docs = [...store(name).entries()].map(([id, data]) => snapshot(id, data));
        return { empty: docs.length === 0, size: docs.length, docs };
      }
    };
  }

  async function runTransaction(work) {
    const writes = [];
    // What each read actually saw, so a second mode can behave like Firestore's optimistic
    // concurrency: when another transaction commits over something this one read, this one
    // is aborted instead of quietly overwriting the movement that won. Without that flag the
    // double behaves exactly as it always has, so the suites that rely on it are untouched.
    const observed = [];
    function sameValue(stored, seen) {
      return JSON.stringify(stored === undefined ? null : stored) ===
        JSON.stringify(seen === undefined ? null : seen);
    }
    function abortError() {
      const error = new Error('ABORTED: a document this transaction read was changed');
      error.code = 10; // gRPC ABORTED
      return error;
    }
    // The real Firestore backend rejects a transaction that reads after it has
    // already written. Doubling that rule here is what makes an ordering mistake in
    // service code fail a test instead of only failing in production, where the
    // whole transaction is lost and the caller is told the change was partial.
    function assertReadsFirst() {
      if (writes.length === 0) return;
      const error = new Error(
        'Firestore transactions require all reads to be executed before all writes.'
      );
      error.code = 3; // gRPC INVALID_ARGUMENT
      throw error;
    }
    const transaction = {
      async get(ref) {
        assertReadsFirst();
        // A query inside a transaction is a read like any other. It is not recorded for the
        // serializable check, because the real backend does not detect a phantom row that way -
        // which is exactly why the intake service also rewrites a mutex document.
        if (ref && ref.__query === true) return ref.__snapshot();
        if (serializable) {
          observed.push({ store: ref.__store, id: ref.id, seen: store(ref.__store).get(ref.id) });
        }
        return ref.get();
      },
      set(ref, data, options) {
        writes.push({ ref, data, options });
        return null;
      },
      delete(ref) {
        writes.push({ ref, remove: true });
        return null;
      }
    };

    const result = await work(transaction);
    if (serializable) {
      for (const read of observed) {
        if (!sameValue(store(read.store).get(read.id), read.seen)) throw abortError();
      }
    }
    // A real commit is all-or-nothing: if applying one write fails, nothing lands. Each
    // write is therefore undoable, and the loop runs without yielding, so an injected fault
    // leaves every document exactly as it was before the transaction ran and no other
    // transaction can observe a half-committed balance.
    const applied = [];
    try {
      for (const write of writes) {
        const docs = store(write.ref.__store);
        applied.push({ store: write.ref.__store, id: write.ref.id, before: docs.get(write.ref.id) });
        if (write.remove) applyDelete(write.ref.__store, write.ref.id);
        else applySet(write.ref.__store, write.ref.id, write.data, write.options);
      }
    } catch (error) {
      for (const entry of applied.reverse()) {
        const docs = store(entry.store);
        if (entry.before === undefined) docs.delete(entry.id);
        else docs.set(entry.id, structuredClone(entry.before));
      }
      throw error;
    }
    return result;
  }

  return {
    collection,
    runTransaction,
    __fail(name, id, operation) {
      faults.add(`${name}/${id}#${operation}`);
    },
    __heal(name, id, operation) {
      faults.delete(`${name}/${id}#${operation}`);
    },
    __seed(name, id, data) {
      store(name).set(id, structuredClone(data));
    },
    __peek(name, id) {
      return store(name).get(id);
    },
    __names() {
      return [...stores.keys()];
    }
  };
}

module.exports = { createFakeFirestore, alreadyExistsError };
