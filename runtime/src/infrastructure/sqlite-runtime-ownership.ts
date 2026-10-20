import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type {RuntimeOwnership} from '../application/ports.js';

// A dedicated connection holds the OS-backed transaction for this process.
// There is no stale timeout/PID deletion and no lock on business/journal tables.
export class SqliteRuntimeOwnership implements RuntimeOwnership {
  private database?:DatabaseSync;
  constructor(private readonly directory:string) {}
  acquire() {
    if(this.database)return;
    let database:DatabaseSync|undefined;
    try {
      mkdirSync(this.directory,{recursive:true,mode:0o700});
      database=new DatabaseSync(join(this.directory,'runtime-owner.lock'));
      database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership(version INTEGER NOT NULL CHECK(version=1))');
      this.database=database;
    } catch {
      database?.close();
      throw new Error('Runtime data directory ownership unavailable; stop its existing Runtime before starting another.');
    }
  }
  release() {
    const database=this.database;
    if(!database)return;
    this.database=undefined;
    // Closing rolls back the private transaction and releases the OS lock.
    database.close();
  }
}
