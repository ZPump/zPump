'use client';

export interface StoredNoteRecord {
  id: string;
  label: string;
  noteId: string;
  spendingKey: string;
  amount: string;
  rawAmount?: string;
  decimals?: number;
  mint?: string;
  owner?: string;
  changeRecipient?: string;
  createdAt?: number;
}

export const STORED_NOTES_STORAGE_KEY = 'ptf.savedNotes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normaliseEntry(entry: unknown): StoredNoteRecord | null {
  if (!isRecord(entry)) {
    return null;
  }
  const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : crypto.randomUUID?.() ?? `${Date.now()}`;
  const label = typeof entry.label === 'string' ? entry.label : 'Note';
  const noteId = typeof entry.noteId === 'string' ? entry.noteId : '';
  const spendingKey = typeof entry.spendingKey === 'string' ? entry.spendingKey : '';
  const amount = typeof entry.amount === 'string' ? entry.amount : '0';
  if (!noteId || !spendingKey) {
    return null;
  }
  const record: StoredNoteRecord = {
    id,
    label,
    noteId,
    spendingKey,
    amount
  };
  if (typeof entry.rawAmount === 'string' && entry.rawAmount.length > 0) {
    record.rawAmount = entry.rawAmount;
  }
  if (typeof entry.decimals === 'number') {
    record.decimals = entry.decimals;
  }
  if (typeof entry.mint === 'string' && entry.mint.length > 0) {
    record.mint = entry.mint;
  }
  if (typeof entry.owner === 'string' && entry.owner.length > 0) {
    record.owner = entry.owner;
  }
  if (typeof entry.changeRecipient === 'string' && entry.changeRecipient.length > 0) {
    record.changeRecipient = entry.changeRecipient;
  }
  if (typeof entry.createdAt === 'number') {
    record.createdAt = entry.createdAt;
  }
  return record;
}

export function readStoredNotes(): StoredNoteRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  const raw = window.localStorage.getItem(STORED_NOTES_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const records: StoredNoteRecord[] = [];
    for (const entry of parsed) {
      const normalised = normaliseEntry(entry);
      if (normalised) {
        records.push(normalised);
      }
    }
    return records;
  } catch {
    return [];
  }
}

export function writeStoredNotes(notes: StoredNoteRecord[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(STORED_NOTES_STORAGE_KEY, JSON.stringify(notes));
  } catch (error) {
    console.warn('[notes] failed to persist stored notes', error);
  }
}

export function upsertStoredNote(note: StoredNoteRecord): StoredNoteRecord[] {
  const current = readStoredNotes();
  const filtered = current.filter((entry) => entry.id !== note.id);
  const next = [...filtered, note];
  writeStoredNotes(next);
  return next;
}

export function removeStoredNotes(ids: string[]): StoredNoteRecord[] {
  if (!ids.length) {
    return readStoredNotes();
  }
  const current = readStoredNotes();
  const next = current.filter((entry) => !ids.includes(entry.id));
  writeStoredNotes(next);
  return next;
}

